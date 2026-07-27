const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { deleteImageFile, saveBase64Image } = require('../utils/image');
const { sendSuccess, sendPaginated, sendError } = require('../utils/response');

// Helper to get custom sheet with nested estimates and values loaded
async function getCustomSheetWithDetails(sheetId) {
    const sheet = await db.prepare('SELECT * FROM custom_sheets WHERE id = ?').get(sheetId);
    if (!sheet) return null;

    const estimates = await db.prepare('SELECT * FROM estimates WHERE custom_sheet_id = ?').all(sheetId);
    for (const est of estimates) {
        const estValues = await db.prepare('SELECT * FROM est_values WHERE estimate_id = ?').all(est.id);
        est.estValues = estValues.map(val => {
            const m = parseFloat(val.markup);
            const markup = isNaN(m) || m <= 0 ? 1 : m;
            return {
                ...val,
                pricePer: (parseFloat(val.basePrice) || 0) * (parseFloat(val.priceModifier) || 0) * markup - (parseFloat(val.discount) || 0)
            };
        });
    }
    sheet.estimates = estimates;
    sheet.custom_images = await db.prepare('SELECT id, custom_sheet_id, note, image, created_at, updated_at FROM images WHERE custom_sheet_id = ?').all(sheetId);
    return sheet;
}

// 1. GET / (List all, customer-specific, or paginated)
router.get('/', async (req, res) => {
    try {
        const { customer_id, page, limit, sortBy, descending } = req.query;

        // A. Customer specific custom sheets
        if (customer_id) {
            const sheets = await db.prepare(`
                SELECT s.*, c.fname AS customer_fname, c.lname AS customer_lname
                FROM custom_sheets s
                LEFT JOIN customers c ON s.customer_id = c.id
                WHERE s.customer_id = ?
            `).all(customer_id);

            const sheetIds = sheets.map(s => s.id);
            let estimates = [];
            let estValues = [];
            if (sheetIds.length > 0) {
                const sheetPlaceholders = sheetIds.map(() => '?').join(',');
                estimates = await db.prepare(`SELECT * FROM estimates WHERE custom_sheet_id IN (${sheetPlaceholders})`).all(...sheetIds);
                
                const estimateIds = estimates.map(e => e.id);
                if (estimateIds.length > 0) {
                    const estPlaceholders = estimateIds.map(() => '?').join(',');
                    estValues = await db.prepare(`SELECT * FROM est_values WHERE estimate_id IN (${estPlaceholders})`).all(...estimateIds);
                }
            }

            const estValuesMap = new Map();
            for (const val of estValues) {
                const m = parseFloat(val.markup);
                const markup = isNaN(m) || m <= 0 ? 1 : m;
                const pricePer = (parseFloat(val.basePrice) || 0) * (parseFloat(val.priceModifier) || 0) * markup - (parseFloat(val.discount) || 0);

                const mappedVal = { ...val, pricePer };
                if (!estValuesMap.has(val.estimate_id)) estValuesMap.set(val.estimate_id, []);
                estValuesMap.get(val.estimate_id).push(mappedVal);
            }

            const estimatesMap = new Map();
            for (const est of estimates) {
                est.estValues = estValuesMap.get(est.id) || [];
                if (!estimatesMap.has(est.custom_sheet_id)) estimatesMap.set(est.custom_sheet_id, []);
                estimatesMap.get(est.custom_sheet_id).push(est);
            }

            for (const sheet of sheets) {
                sheet.customer = sheet.customer_id ? {
                    id: sheet.customer_id,
                    fname: sheet.customer_fname,
                    lname: sheet.customer_lname
                } : null;
                sheet.estimates = estimatesMap.get(sheet.id) || [];
                sheet.custom_images = [];
            }
            return sendSuccess(res, sheets);
        }

        // B. Paginated & Sorted custom sheets
        if (page) {
            const sortColumn = sortBy || 'created_at';
            const sortDirection = descending === 'true' ? 'DESC' : 'ASC';
            const parsedLimit = parseInt(limit) || 10;
            const currentPage = parseInt(page) || 1;
            const offset = (currentPage - 1) * parsedLimit;

            const totalRecord = await db.prepare('SELECT COUNT(*) as count FROM custom_sheets').get();
            const total = totalRecord ? totalRecord.count : 0;
            const lastPage = Math.ceil(total / parsedLimit) || 1;

            const allowedColumns = ['id', 'customer_id', 'name', 'created_at', 'updated_at'];
            const validatedSortCol = allowedColumns.includes(sortColumn) ? sortColumn : 'created_at';

            const sheets = await db.prepare(`
                SELECT s.*, c.fname AS customer_fname, c.lname AS customer_lname
                FROM custom_sheets s
                LEFT JOIN customers c ON s.customer_id = c.id
                ORDER BY s.${validatedSortCol} ${sortDirection}
                LIMIT ? OFFSET ?
            `).all(parsedLimit, offset);

            const sheetIds = sheets.map(s => s.id);
            let estimates = [];
            let estValues = [];
            if (sheetIds.length > 0) {
                const sheetPlaceholders = sheetIds.map(() => '?').join(',');
                estimates = await db.prepare(`SELECT * FROM estimates WHERE custom_sheet_id IN (${sheetPlaceholders})`).all(...sheetIds);

                const estimateIds = estimates.map(e => e.id);
                if (estimateIds.length > 0) {
                    const estPlaceholders = estimateIds.map(() => '?').join(',');
                    estValues = await db.prepare(`SELECT * FROM est_values WHERE estimate_id IN (${estPlaceholders})`).all(...estimateIds);
                }
            }

            const estValuesMap = new Map();
            for (const val of estValues) {
                const m = parseFloat(val.markup);
                const markup = isNaN(m) || m <= 0 ? 1 : m;
                const pricePer = (parseFloat(val.basePrice) || 0) * (parseFloat(val.priceModifier) || 0) * markup - (parseFloat(val.discount) || 0);

                const mappedVal = { ...val, pricePer };
                if (!estValuesMap.has(val.estimate_id)) estValuesMap.set(val.estimate_id, []);
                estValuesMap.get(val.estimate_id).push(mappedVal);
            }

            const estimatesMap = new Map();
            for (const est of estimates) {
                est.estValues = estValuesMap.get(est.id) || [];
                if (!estimatesMap.has(est.custom_sheet_id)) estimatesMap.set(est.custom_sheet_id, []);
                estimatesMap.get(est.custom_sheet_id).push(est);
            }

            for (const sheet of sheets) {
                sheet.customer = sheet.customer_id ? {
                    id: sheet.customer_id,
                    fname: sheet.customer_fname,
                    lname: sheet.customer_lname
                } : null;
                sheet.estimates = estimatesMap.get(sheet.id) || [];
                sheet.custom_images = [];
            }

            return sendPaginated(res, sheets, {
                currentPage,
                lastPage,
                perPage: parsedLimit,
                total
            });
        }

        // C. Simple flat list
        const sheets = await db.prepare(`
            SELECT s.*, c.fname AS customer_fname, c.lname AS customer_lname
            FROM custom_sheets s
            LEFT JOIN customers c ON s.customer_id = c.id
        `).all();

        const estimates = await db.prepare('SELECT * FROM estimates').all();
        const estValues = await db.prepare('SELECT * FROM est_values').all();

        const estValuesMap = new Map();
        for (const val of estValues) {
            const m = parseFloat(val.markup);
            const markup = isNaN(m) || m <= 0 ? 1 : m;
            const pricePer = (parseFloat(val.basePrice) || 0) * (parseFloat(val.priceModifier) || 0) * markup - (parseFloat(val.discount) || 0);

            const mappedVal = { ...val, pricePer };
            if (!estValuesMap.has(val.estimate_id)) estValuesMap.set(val.estimate_id, []);
            estValuesMap.get(val.estimate_id).push(mappedVal);
        }

        const estimatesMap = new Map();
        for (const est of estimates) {
            est.estValues = estValuesMap.get(est.id) || [];
            if (!estimatesMap.has(est.custom_sheet_id)) estimatesMap.set(est.custom_sheet_id, []);
            estimatesMap.get(est.custom_sheet_id).push(est);
        }

        for (const sheet of sheets) {
            sheet.customer = sheet.customer_id ? {
                id: sheet.customer_id,
                fname: sheet.customer_fname,
                lname: sheet.customer_lname
            } : null;
            sheet.estimates = estimatesMap.get(sheet.id) || [];
            sheet.custom_images = [];
        }
        return sendSuccess(res, sheets);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /:id (Show single custom sheet details)
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const sheet = await getCustomSheetWithDetails(id);
        if (!sheet) {
            return sendError(res, 'Custom sheet not found', 404);
        }
        return sendSuccess(res, sheet);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. POST / (Create custom sheet with nested estimates/values)
router.post('/', async (req, res) => {
    try {
        const { customer_id, name, note, estimates, custom_images } = req.body;
        const timestamp = getTimestamp();

        if (!customer_id || parseInt(customer_id) === 0) {
            return sendError(res, 'Customer cannot be blank', 400);
        }

        const transaction = db.transaction(async () => {
            // Save custom sheet
            const insertSheet = db.prepare(`
                INSERT INTO custom_sheets (customer_id, name, note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `);
            const sheetResult = await insertSheet.run(customer_id, name || '', note || null, timestamp, timestamp);
            const sheetId = sheetResult.lastInsertRowid;

            // Save estimates and their est_values
            if (Array.isArray(estimates)) {
                const insertEst = db.prepare(`
                    INSERT INTO estimates (custom_sheet_id, name, note, isPrimary, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);

                const insertVal = db.prepare(`
                    INSERT INTO est_values (estimate_id, name, type, priceType, amt, basePrice, markup, discount, priceModifier, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const est of estimates) {
                    const estResult = await insertEst.run(
                        sheetId,
                        est.name || '',
                        est.note || null,
                        est.isPrimary ? 1 : 0,
                        timestamp,
                        timestamp
                    );
                    const estId = estResult.lastInsertRowid;

                    if (Array.isArray(est.estValues)) {
                        for (const val of est.estValues) {
                            await insertVal.run(
                                estId,
                                val.name || 'unknown',
                                val.type || '',
                                val.priceType || null,
                                val.amt !== undefined ? parseFloat(val.amt) : 0,
                                val.basePrice !== undefined ? parseFloat(val.basePrice) : 0,
                                val.markup !== undefined ? parseFloat(val.markup) : 0,
                                val.discount !== undefined ? parseFloat(val.discount) : 0,
                                val.priceModifier !== undefined ? parseFloat(val.priceModifier) : 0,
                                timestamp,
                                timestamp
                            );
                        }
                    }
                }
            }

            // Save uploaded custom images
            if (Array.isArray(custom_images) && custom_images.length > 0) {
                const maxImageRecord = await db.prepare('SELECT MAX(id) as maxId FROM images').get();
                let nextImageId = (maxImageRecord && maxImageRecord.maxId ? maxImageRecord.maxId : 0) + 1;

                const insertImage = db.prepare(`
                    INSERT INTO images (custom_sheet_id, note, image, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                `);

                for (const img of custom_images) {
                    if (img.image) {
                        const savedPath = saveBase64Image(img.image, 'custom', sheetId, nextImageId);
                        await insertImage.run(sheetId, img.note || null, savedPath, timestamp, timestamp);
                        nextImageId++;
                    }
                }
            }

            return sheetId;
        });

        const sheetId = await transaction();
        const fullSheet = await getCustomSheetWithDetails(sheetId);
        return sendSuccess(res, fullSheet, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. PUT /:id (Differential update on custom sheet)
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params; // customSheet_id
        const { customer_id, name, note, estimatesToDelete, estimates, custom_images } = req.body;
        const timestamp = getTimestamp();

        // Check if custom sheet exists
        const existingSheet = await db.prepare('SELECT id FROM custom_sheets WHERE id = ?').get(id);
        if (!existingSheet) {
            return sendError(res, 'Custom sheet not found', 404);
        }

        if (!customer_id || parseInt(customer_id) === 0) {
            return sendError(res, 'Customer cannot be blank', 400);
        }

        const transaction = db.transaction(async () => {
            // Update custom sheet info
            await db.prepare(`
                UPDATE custom_sheets
                SET name = ?, note = ?, updated_at = ?
                WHERE id = ?
            `).run(name || '', note || null, timestamp, id);

            // Delete estimates listed in estimatesToDelete
            if (Array.isArray(estimatesToDelete)) {
                for (const delId of estimatesToDelete) {
                    await db.prepare('DELETE FROM est_values WHERE estimate_id = ?').run(delId);
                    await db.prepare('DELETE FROM estimates WHERE id = ?').run(delId);
                }
            }

            // Save/Update estimates
            if (Array.isArray(estimates)) {
                const insertEst = db.prepare(`
                    INSERT INTO estimates (custom_sheet_id, name, note, isPrimary, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);

                const updateEst = db.prepare(`
                    UPDATE estimates
                    SET name = ?, note = ?, isPrimary = ?, updated_at = ?
                    WHERE id = ?
                `);

                const insertVal = db.prepare(`
                    INSERT INTO est_values (estimate_id, name, type, priceType, amt, basePrice, markup, discount, priceModifier, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                const updateVal = db.prepare(`
                    UPDATE est_values
                    SET name = ?, priceType = ?, type = ?, basePrice = ?, markup = ?, discount = ?, priceModifier = ?, amt = ?, updated_at = ?
                    WHERE id = ?
                `);

                const deleteVal = db.prepare('DELETE FROM est_values WHERE id = ?');

                for (const est of estimates) {
                    if (est.id) {
                        // 1. Update existing estimate
                        await updateEst.run(est.name || '', est.note || null, est.isPrimary ? 1 : 0, timestamp, est.id);

                        // Delete removed est_values
                        if (Array.isArray(est.estValuesToDelete)) {
                            for (const delValId of est.estValuesToDelete) {
                                await deleteVal.run(delValId);
                            }
                        }

                        // Loop estValues
                        if (Array.isArray(est.estValues)) {
                            for (const val of est.estValues) {
                                if (val.id) {
                                    // Update existing estValue
                                    await updateVal.run(
                                        val.name || 'unknown',
                                        val.priceType || null,
                                        val.type || '',
                                        val.basePrice !== undefined ? parseFloat(val.basePrice) : 0,
                                        val.markup !== undefined ? parseFloat(val.markup) : 0,
                                        val.discount !== undefined ? parseFloat(val.discount) : 0,
                                        val.priceModifier !== undefined ? parseFloat(val.priceModifier) : 0,
                                        val.amt !== undefined ? parseFloat(val.amt) : 0,
                                        timestamp,
                                        val.id
                                    );
                                } else {
                                    // Insert new estValue under existing estimate
                                    await insertVal.run(
                                        est.id,
                                        val.name || 'unknown',
                                        val.type || '',
                                        val.priceType || null,
                                        val.amt !== undefined ? parseFloat(val.amt) : 0,
                                        val.basePrice !== undefined ? parseFloat(val.basePrice) : 0,
                                        val.markup !== undefined ? parseFloat(val.markup) : 0,
                                        val.discount !== undefined ? parseFloat(val.discount) : 0,
                                        val.priceModifier !== undefined ? parseFloat(val.priceModifier) : 0,
                                        timestamp,
                                        timestamp
                                    );
                                }
                            }
                        }
                    } else {
                        // 2. Insert new estimate
                        const estResult = await insertEst.run(
                            id,
                            est.name || '',
                            est.note || null,
                            est.isPrimary ? 1 : 0,
                            timestamp,
                            timestamp
                        );
                        const newEstId = estResult.lastInsertRowid;

                        if (Array.isArray(est.estValues)) {
                            for (const val of est.estValues) {
                                await insertVal.run(
                                    newEstId,
                                    val.name || 'unknown',
                                    val.type || '',
                                    val.priceType || null,
                                    val.amt !== undefined ? parseFloat(val.amt) : 0,
                                    val.basePrice !== undefined ? parseFloat(val.basePrice) : 0,
                                    val.markup !== undefined ? parseFloat(val.markup) : 0,
                                    val.discount !== undefined ? parseFloat(val.discount) : 0,
                                    val.priceModifier !== undefined ? parseFloat(val.priceModifier) : 0,
                                    timestamp,
                                    timestamp
                                );
                            }
                        }
                    }
                }
            }

            // Save/Update custom images
            if (Array.isArray(custom_images) && custom_images.length > 0) {
                const maxImageRecord = await db.prepare('SELECT MAX(id) as maxId FROM images').get();
                let nextImageId = (maxImageRecord && maxImageRecord.maxId ? maxImageRecord.maxId : 0) + 1;

                const insertImage = db.prepare(`
                    INSERT INTO images (custom_sheet_id, note, image, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                `);

                const updateImageNote = db.prepare(`
                    UPDATE images
                    SET note = ?, updated_at = ?
                    WHERE id = ?
                `);

                for (const img of custom_images) {
                    if (img.id) {
                        // Update note for existing image
                        await updateImageNote.run(img.note || '', timestamp, img.id);
                    } else if (img.image) {
                        // Save new Base64 image
                        const savedPath = saveBase64Image(img.image, 'custom', id, nextImageId);
                        await insertImage.run(id, img.note || null, savedPath, timestamp, timestamp);
                        nextImageId++;
                    }
                }
            }
        });

        await transaction();
        const fullSheet = await getCustomSheetWithDetails(id);
        return sendSuccess(res, fullSheet);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. DELETE /:id (Delete custom sheet and cascade estimates/estimate values)
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const sheet = await db.prepare('SELECT id FROM custom_sheets WHERE id = ?').get(id);
        if (!sheet) {
            return sendError(res, 'Custom sheet not found', 404);
        }

        // Fetch associated images and delete their physical files
        const images = await db.prepare('SELECT image FROM images WHERE custom_sheet_id = ?').all(id);
        for (const img of images) {
            deleteImageFile(img.image);
        }

        const transaction = db.transaction(async () => {
            // Delete custom images from DB
            await db.prepare('DELETE FROM images WHERE custom_sheet_id = ?').run(id);
            // Find estimates
            const estimates = await db.prepare('SELECT id FROM estimates WHERE custom_sheet_id = ?').all(id);
            for (const est of estimates) {
                // Delete estimate values
                await db.prepare('DELETE FROM est_values WHERE estimate_id = ?').run(est.id);
            }
            // Delete estimates
            await db.prepare('DELETE FROM estimates WHERE custom_sheet_id = ?').run(id);
            // Delete custom sheet
            await db.prepare('DELETE FROM custom_sheets WHERE id = ?').run(id);
        });

        await transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 6. DELETE /images/:id (Delete specific custom image by ID)
router.delete('/images/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const image = await db.prepare('SELECT * FROM images WHERE id = ? AND custom_sheet_id IS NOT NULL').get(id);
        
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
