const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { deleteImageFile, saveBase64Image } = require('../utils/image');
const { sendSuccess, sendPaginated, sendError } = require('../utils/response');

// Helper to get gold credit details loaded (nested customer, employee, items, images)
async function getCreditWithDetails(creditId) {
    const credit = await db.prepare('SELECT * FROM goldcredits WHERE id = ?').get(creditId);
    if (credit) {
        credit.credit_images = await db.prepare('SELECT id, goldcredit_id, note, image, created_at, updated_at FROM images WHERE goldcredit_id = ?').all(creditId);
        credit.credit_items = await db.prepare('SELECT * FROM credit_items WHERE goldcredit_id = ?').all(creditId);
        credit.customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(credit.customer_id) || null;
        credit.employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(credit.employee_id) || null;
    }
    return credit || null;
}

// 1. GET / (List all, customer-specific, or paginated)
router.get('/', async (req, res) => {
    try {
        const { customer_id, page, limit, sortBy, descending } = req.query;

        // A. Customer specific credits
        if (customer_id) {
            const credits = await db.prepare(`
                SELECT g.*, 
                       c.fname AS customer_fname, c.lname AS customer_lname,
                       e.name AS employee_name, e.active AS employee_active
                FROM goldcredits g
                LEFT JOIN customers c ON g.customer_id = c.id
                LEFT JOIN employees e ON g.employee_id = e.id
                WHERE g.customer_id = ?
            `).all(customer_id);

            const creditIds = credits.map(c => c.id);
            let creditItems = [];
            if (creditIds.length > 0) {
                const placeholders = creditIds.map(() => '?').join(',');
                creditItems = await db.prepare(`SELECT * FROM credit_items WHERE goldcredit_id IN (${placeholders})`).all(...creditIds);
            }

            const itemsMap = new Map();
            for (const item of creditItems) {
                if (!itemsMap.has(item.goldcredit_id)) itemsMap.set(item.goldcredit_id, []);
                itemsMap.get(item.goldcredit_id).push(item);
            }

            for (const credit of credits) {
                credit.customer = credit.customer_id ? {
                    id: credit.customer_id,
                    fname: credit.customer_fname,
                    lname: credit.customer_lname
                } : null;
                credit.employee = credit.employee_id ? {
                    id: credit.employee_id,
                    name: credit.employee_name,
                    active: credit.employee_active
                } : null;
                credit.credit_items = itemsMap.get(credit.id) || [];
                credit.credit_images = [];
            }
            return sendSuccess(res, credits);
        }

        // B. Paginated & Sorted credits
        if (page) {
            const sortColumn = sortBy || 'created_at';
            const sortDirection = descending === 'true' ? 'DESC' : 'ASC';
            const parsedLimit = parseInt(limit) || 10;
            const currentPage = parseInt(page) || 1;
            const offset = (currentPage - 1) * parsedLimit;

            const totalRecord = await db.prepare('SELECT COUNT(*) as count FROM goldcredits').get();
            const total = totalRecord ? totalRecord.count : 0;
            const lastPage = Math.ceil(total / parsedLimit) || 1;

            const allowedColumns = ['id', 'customer_id', 'employee_id', 'gold_cad', 'plat_cad', 'gold_date', 'used', 'credit_type', 'created_at', 'updated_at'];
            const validatedSortCol = allowedColumns.includes(sortColumn) ? sortColumn : 'created_at';

            const credits = await db.prepare(`
                SELECT g.*, 
                       c.fname AS customer_fname, c.lname AS customer_lname,
                       e.name AS employee_name, e.active AS employee_active
                FROM goldcredits g
                LEFT JOIN customers c ON g.customer_id = c.id
                LEFT JOIN employees e ON g.employee_id = e.id
                ORDER BY g.${validatedSortCol} ${sortDirection}
                LIMIT ? OFFSET ?
            `).all(parsedLimit, offset);

            const creditIds = credits.map(c => c.id);
            let creditItems = [];
            if (creditIds.length > 0) {
                const placeholders = creditIds.map(() => '?').join(',');
                creditItems = await db.prepare(`SELECT * FROM credit_items WHERE goldcredit_id IN (${placeholders})`).all(...creditIds);
            }

            const itemsMap = new Map();
            for (const item of creditItems) {
                if (!itemsMap.has(item.goldcredit_id)) itemsMap.set(item.goldcredit_id, []);
                itemsMap.get(item.goldcredit_id).push(item);
            }

            for (const credit of credits) {
                credit.customer = credit.customer_id ? {
                    id: credit.customer_id,
                    fname: credit.customer_fname,
                    lname: credit.customer_lname
                } : null;
                credit.employee = credit.employee_id ? {
                    id: credit.employee_id,
                    name: credit.employee_name,
                    active: credit.employee_active
                } : null;
                credit.credit_items = itemsMap.get(credit.id) || [];
                credit.credit_images = [];
            }

            return sendPaginated(res, credits, {
                currentPage,
                lastPage,
                perPage: parsedLimit,
                total
            });
        }

        // C. List all credits flat
        const credits = await db.prepare(`
            SELECT g.*, 
                   c.fname AS customer_fname, c.lname AS customer_lname,
                   e.name AS employee_name, e.active AS employee_active
            FROM goldcredits g
            LEFT JOIN customers c ON g.customer_id = c.id
            LEFT JOIN employees e ON g.employee_id = e.id
        `).all();

        const creditItems = await db.prepare('SELECT * FROM credit_items').all();

        const itemsMap = new Map();
        for (const item of creditItems) {
            if (!itemsMap.has(item.goldcredit_id)) itemsMap.set(item.goldcredit_id, []);
            itemsMap.get(item.goldcredit_id).push(item);
        }

        for (const credit of credits) {
            credit.customer = credit.customer_id ? {
                id: credit.customer_id,
                fname: credit.customer_fname,
                lname: credit.customer_lname
            } : null;
            credit.employee = credit.employee_id ? {
                id: credit.employee_id,
                name: credit.employee_name,
                active: credit.employee_active
            } : null;
            credit.credit_items = itemsMap.get(credit.id) || [];
            credit.credit_images = [];
        }
        return sendSuccess(res, credits);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /:id (Show single credit details)
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const credit = await getCreditWithDetails(id);
        if (!credit) {
            return sendError(res, 'Credit not found', 404);
        }
        return sendSuccess(res, credit);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. POST / (Create a credit record)
router.post('/', async (req, res) => {
    try {
        const { customer_id, employee_id, goldCAD, platCAD, metalPriceDate, note, used, credit_type, credit_items, credit_images } = req.body;
        const timestamp = getTimestamp();

        if (!customer_id || parseInt(customer_id) === 0) {
            return sendError(res, 'Customer cannot be blank', 400);
        }

        const insertCredit = db.prepare(`
            INSERT INTO goldcredits (customer_id, employee_id, gold_cad, plat_cad, gold_date, note, used, credit_type, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = await insertCredit.run(
            customer_id,
            employee_id || 1,
            goldCAD !== undefined ? parseFloat(goldCAD) : 0,
            platCAD !== undefined ? parseFloat(platCAD) : 0,
            metalPriceDate || '',
            note || null,
            used ? 1 : 0,
            credit_type || 'credit',
            timestamp,
            timestamp
        );

        const creditId = result.lastInsertRowid;

        // Save nested items
        if (Array.isArray(credit_items) && credit_items.length > 0) {
            const insertItem = db.prepare(`
                INSERT INTO credit_items (goldcredit_id, itemId, markup, multiplier, value, weight, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const item of credit_items) {
                await insertItem.run(
                    creditId,
                    item.item !== undefined ? parseInt(item.item) : 0,
                    item.markup !== undefined ? parseFloat(item.markup) : 0,
                    item.multiplier !== undefined ? parseFloat(item.multiplier) : 0,
                    item.value !== undefined ? parseFloat(item.value) : 0,
                    item.weight !== undefined ? parseFloat(item.weight) : 0,
                    timestamp,
                    timestamp
                );
            }
        }

        // Save nested images
        if (Array.isArray(credit_images) && credit_images.length > 0) {
            const maxImageRecord = await db.prepare('SELECT MAX(id) as maxId FROM images').get();
            let nextImageId = (maxImageRecord && maxImageRecord.maxId ? maxImageRecord.maxId : 0) + 1;

            const insertImage = db.prepare(`
                INSERT INTO images (goldcredit_id, note, image, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `);

            for (const img of credit_images) {
                if (img.image) {
                    const savedPath = saveBase64Image(img.image, 'credit', creditId, nextImageId);
                    await insertImage.run(creditId, img.note || null, savedPath, timestamp, timestamp);
                    nextImageId++;
                }
            }
        }

        const newCredit = await getCreditWithDetails(creditId);
        return sendSuccess(res, newCredit, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. PUT /:id (Update main credit info)
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { customer_id, note, used, credit_type } = req.body;
        const timestamp = getTimestamp();

        // Check if credit exists
        const existingCredit = await db.prepare('SELECT id FROM goldcredits WHERE id = ?').get(id);
        if (!existingCredit) {
            return sendError(res, 'Credit not found', 404);
        }

        if (!customer_id || parseInt(customer_id) === 0) {
            return sendError(res, 'Customer cannot be blank', 400);
        }

        const update = db.prepare(`
            UPDATE goldcredits
            SET customer_id = ?, note = ?, used = ?, credit_type = ?, updated_at = ?
            WHERE id = ?
        `);
        await update.run(
            customer_id,
            note || null,
            used ? 1 : 0,
            credit_type || 'credit',
            timestamp,
            id
        );

        const updatedCredit = await getCreditWithDetails(id);
        return sendSuccess(res, updatedCredit);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. DELETE /:id (Delete credit and related files/db rows)
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const credit = await db.prepare('SELECT id FROM goldcredits WHERE id = ?').get(id);
        if (!credit) {
            return sendError(res, 'Credit not found', 404);
        }

        // Fetch associated images and delete their physical files
        const images = await db.prepare('SELECT image FROM images WHERE goldcredit_id = ?').all(id);
        for (const img of images) {
            deleteImageFile(img.image);
        }

        const transaction = db.transaction(async () => {
            // Delete credit images from DB
            await db.prepare('DELETE FROM images WHERE goldcredit_id = ?').run(id);
            // Delete credit items from DB
            await db.prepare('DELETE FROM credit_items WHERE goldcredit_id = ?').run(id);
            // Delete credit record
            await db.prepare('DELETE FROM goldcredits WHERE id = ?').run(id);
        });

        await transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 6. DELETE /images/:id (Delete specific credit image by ID)
router.delete('/images/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const image = await db.prepare('SELECT * FROM images WHERE id = ? AND goldcredit_id IS NOT NULL').get(id);

        if (image) {
            deleteImageFile(image.image);
            await db.prepare('DELETE FROM images WHERE id = ?').run(id);
            return sendSuccess(res, { id: parseInt(id), image: image.image });
        } else {
            return sendError(res, 'Image not found', 404);
        }
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
