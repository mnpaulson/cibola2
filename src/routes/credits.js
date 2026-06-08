const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { deleteImageFile, saveBase64Image } = require('../utils/image');
const { sendSuccess, sendPaginated, sendError } = require('../utils/response');

// Helper to get gold credit details loaded (nested customer, employee, items, images)
function getCreditWithDetails(creditId) {
    const credit = db.prepare('SELECT * FROM goldcredits WHERE id = ?').get(creditId);
    if (credit) {
        credit.credit_images = db.prepare('SELECT * FROM credit_images WHERE goldcredit_id = ?').all(creditId);
        credit.credit_items = db.prepare('SELECT * FROM credit_items WHERE goldcredit_id = ?').all(creditId);
        credit.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(credit.customer_id) || null;
        credit.employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(credit.employee_id) || null;
    }
    return credit || null;
}

// 1. GET / (List all, customer-specific, or paginated)
router.get('/', (req, res) => {
    try {
        const { customer_id, page, limit, sortBy, descending } = req.query;

        // A. Customer specific credits
        if (customer_id) {
            const credits = db.prepare('SELECT * FROM goldcredits WHERE customer_id = ?').all(customer_id);
            for (const credit of credits) {
                credit.credit_images = db.prepare('SELECT * FROM credit_images WHERE goldcredit_id = ?').all(credit.id);
                credit.credit_items = db.prepare('SELECT * FROM credit_items WHERE goldcredit_id = ?').all(credit.id);
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

            const totalRecord = db.prepare('SELECT COUNT(*) as count FROM goldcredits').get();
            const total = totalRecord ? totalRecord.count : 0;
            const lastPage = Math.ceil(total / parsedLimit) || 1;

            const allowedColumns = ['id', 'customer_id', 'employee_id', 'gold_cad', 'plat_cad', 'gold_date', 'used', 'credit_type', 'created_at', 'updated_at'];
            const validatedSortCol = allowedColumns.includes(sortColumn) ? sortColumn : 'created_at';

            const credits = db.prepare(`
                SELECT * FROM goldcredits
                ORDER BY ${validatedSortCol} ${sortDirection}
                LIMIT ? OFFSET ?
            `).all(parsedLimit, offset);

            for (const credit of credits) {
                credit.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(credit.customer_id) || null;
                credit.employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(credit.employee_id) || null;
                credit.credit_images = db.prepare('SELECT * FROM credit_images WHERE goldcredit_id = ?').all(credit.id);
                credit.credit_items = db.prepare('SELECT * FROM credit_items WHERE goldcredit_id = ?').all(credit.id);
            }

            return sendPaginated(res, credits, {
                currentPage,
                lastPage,
                perPage: parsedLimit,
                total
            });
        }

        // C. List all credits flat
        const credits = db.prepare('SELECT * FROM goldcredits').all();
        for (const credit of credits) {
            credit.credit_images = db.prepare('SELECT * FROM credit_images WHERE goldcredit_id = ?').all(credit.id);
            credit.credit_items = db.prepare('SELECT * FROM credit_items WHERE goldcredit_id = ?').all(credit.id);
            credit.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(credit.customer_id) || null;
            credit.employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(credit.employee_id) || null;
        }
        return sendSuccess(res, credits);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /:id (Show single credit details)
router.get('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const credit = getCreditWithDetails(id);
        if (!credit) {
            return sendError(res, 'Credit not found', 404);
        }
        return sendSuccess(res, credit);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. POST / (Create a credit record)
router.post('/', (req, res) => {
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

        const result = insertCredit.run(
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
                insertItem.run(
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
            const maxImageRecord = db.prepare('SELECT MAX(id) as maxId FROM credit_images').get();
            let nextImageId = (maxImageRecord && maxImageRecord.maxId ? maxImageRecord.maxId : 0) + 1;

            const insertImage = db.prepare(`
                INSERT INTO credit_images (goldcredit_id, note, image, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `);

            for (const img of credit_images) {
                if (img.image) {
                    const savedPath = saveBase64Image(img.image, 'credit', creditId, nextImageId);
                    insertImage.run(creditId, img.note || null, savedPath, timestamp, timestamp);
                    nextImageId++;
                }
            }
        }

        const newCredit = getCreditWithDetails(creditId);
        return sendSuccess(res, newCredit, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. PUT /:id (Update main credit info)
router.put('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { customer_id, note, used, credit_type } = req.body;
        const timestamp = getTimestamp();

        // Check if credit exists
        const existingCredit = db.prepare('SELECT id FROM goldcredits WHERE id = ?').get(id);
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
        update.run(
            customer_id,
            note || null,
            used ? 1 : 0,
            credit_type || 'credit',
            timestamp,
            id
        );

        const updatedCredit = getCreditWithDetails(id);
        return sendSuccess(res, updatedCredit);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. DELETE /:id (Delete credit and related files/db rows)
router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;

        const credit = db.prepare('SELECT id FROM goldcredits WHERE id = ?').get(id);
        if (!credit) {
            return sendError(res, 'Credit not found', 404);
        }

        // Fetch associated images and delete their physical files
        const images = db.prepare('SELECT image FROM credit_images WHERE goldcredit_id = ?').all(id);
        for (const img of images) {
            deleteImageFile(img.image);
        }

        const transaction = db.transaction(() => {
            // Delete credit images from DB
            db.prepare('DELETE FROM credit_images WHERE goldcredit_id = ?').run(id);
            // Delete credit items from DB
            db.prepare('DELETE FROM credit_items WHERE goldcredit_id = ?').run(id);
            // Delete credit record
            db.prepare('DELETE FROM goldcredits WHERE id = ?').run(id);
        });

        transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
