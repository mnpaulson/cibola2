const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { sendSuccess, sendPaginated, sendError } = require('../utils/response');

// Helper to get custom sheet with nested estimates and values loaded
function getCustomSheetWithDetails(sheetId) {
    const sheet = db.prepare('SELECT * FROM custom_sheets WHERE id = ?').get(sheetId);
    if (!sheet) return null;

    const estimates = db.prepare('SELECT * FROM estimates WHERE custom_sheet_id = ?').all(sheetId);
    for (const est of estimates) {
        est.estValues = db.prepare('SELECT * FROM est_values WHERE estimate_id = ?').all(est.id);
    }
    sheet.estimates = estimates;
    return sheet;
}

// 1. GET / (List all, customer-specific, or paginated)
router.get('/', (req, res) => {
    try {
        const { customer_id, page, limit, sortBy, descending } = req.query;

        // A. Customer specific custom sheets
        if (customer_id) {
            const sheets = db.prepare('SELECT * FROM custom_sheets WHERE customer_id = ?').all(customer_id);
            for (const sheet of sheets) {
                const estimates = db.prepare('SELECT * FROM estimates WHERE custom_sheet_id = ?').all(sheet.id);
                for (const est of estimates) {
                    est.estValues = db.prepare('SELECT * FROM est_values WHERE estimate_id = ?').all(est.id);
                }
                sheet.estimates = estimates;
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

            const totalRecord = db.prepare('SELECT COUNT(*) as count FROM custom_sheets').get();
            const total = totalRecord ? totalRecord.count : 0;
            const lastPage = Math.ceil(total / parsedLimit) || 1;

            const allowedColumns = ['id', 'customer_id', 'name', 'created_at', 'updated_at'];
            const validatedSortCol = allowedColumns.includes(sortColumn) ? sortColumn : 'created_at';

            const sheets = db.prepare(`
                SELECT * FROM custom_sheets
                ORDER BY ${validatedSortCol} ${sortDirection}
                LIMIT ? OFFSET ?
            `).all(parsedLimit, offset);

            for (const sheet of sheets) {
                sheet.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(sheet.customer_id) || null;
                const estimates = db.prepare('SELECT * FROM estimates WHERE custom_sheet_id = ?').all(sheet.id);
                for (const est of estimates) {
                    est.estValues = db.prepare('SELECT * FROM est_values WHERE estimate_id = ?').all(est.id);
                }
                sheet.estimates = estimates;
            }

            return sendPaginated(res, sheets, {
                currentPage,
                lastPage,
                perPage: parsedLimit,
                total
            });
        }

        // C. Simple flat list
        const sheets = db.prepare('SELECT * FROM custom_sheets').all();
        for (const sheet of sheets) {
            sheet.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(sheet.customer_id) || null;
            const estimates = db.prepare('SELECT * FROM estimates WHERE custom_sheet_id = ?').all(sheet.id);
            for (const est of estimates) {
                est.estValues = db.prepare('SELECT * FROM est_values WHERE estimate_id = ?').all(est.id);
            }
            sheet.estimates = estimates;
        }
        return sendSuccess(res, sheets);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /:id (Show single custom sheet details)
router.get('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const sheet = getCustomSheetWithDetails(id);
        if (!sheet) {
            return sendError(res, 'Custom sheet not found', 404);
        }
        return sendSuccess(res, sheet);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. POST / (Create custom sheet with nested estimates/values)
router.post('/', (req, res) => {
    try {
        const { customer_id, name, note, estimates } = req.body;
        const timestamp = getTimestamp();

        if (!customer_id || parseInt(customer_id) === 0) {
            return sendError(res, 'Customer cannot be blank', 400);
        }

        const transaction = db.transaction(() => {
            // Save custom sheet
            const insertSheet = db.prepare(`
                INSERT INTO custom_sheets (customer_id, name, note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `);
            const sheetResult = insertSheet.run(customer_id, name || '', note || null, timestamp, timestamp);
            const sheetId = sheetResult.lastInsertRowid;

            // Save estimates and their est_values
            if (Array.isArray(estimates)) {
                const insertEst = db.prepare(`
                    INSERT INTO estimates (custom_sheet_id, name, note, isPrimary, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);

                const insertVal = db.prepare(`
                    INSERT INTO est_values (estimate_id, name, type, priceType, amt, pricePer, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const est of estimates) {
                    const estResult = insertEst.run(
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
                            insertVal.run(
                                estId,
                                val.name || 'unknown',
                                val.type || '',
                                val.priceType || null,
                                val.amt !== undefined ? parseFloat(val.amt) : 0,
                                val.pricePer !== undefined ? parseFloat(val.pricePer) : 0,
                                timestamp,
                                timestamp
                            );
                        }
                    }
                }
            }

            return sheetId;
        });

        const sheetId = transaction();
        const fullSheet = getCustomSheetWithDetails(sheetId);
        return sendSuccess(res, fullSheet, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. PUT /:id (Differential update on custom sheet)
router.put('/:id', (req, res) => {
    try {
        const { id } = req.params; // customSheet_id
        const { customer_id, name, note, estimatesToDelete, estimates } = req.body;
        const timestamp = getTimestamp();

        // Check if custom sheet exists
        const existingSheet = db.prepare('SELECT id FROM custom_sheets WHERE id = ?').get(id);
        if (!existingSheet) {
            return sendError(res, 'Custom sheet not found', 404);
        }

        if (!customer_id || parseInt(customer_id) === 0) {
            return sendError(res, 'Customer cannot be blank', 400);
        }

        const transaction = db.transaction(() => {
            // Update custom sheet info
            db.prepare(`
                UPDATE custom_sheets
                SET name = ?, note = ?, updated_at = ?
                WHERE id = ?
            `).run(name || '', note || null, timestamp, id);

            // Delete estimates listed in estimatesToDelete
            if (Array.isArray(estimatesToDelete)) {
                for (const delId of estimatesToDelete) {
                    db.prepare('DELETE FROM est_values WHERE estimate_id = ?').run(delId);
                    db.prepare('DELETE FROM estimates WHERE id = ?').run(delId);
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
                    INSERT INTO est_values (estimate_id, name, type, priceType, amt, pricePer, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);

                const updateVal = db.prepare(`
                    UPDATE est_values
                    SET name = ?, priceType = ?, type = ?, pricePer = ?, amt = ?, updated_at = ?
                    WHERE id = ?
                `);

                const deleteVal = db.prepare('DELETE FROM est_values WHERE id = ?');

                for (const est of estimates) {
                    if (est.id) {
                        // 1. Update existing estimate
                        updateEst.run(est.name || '', est.note || null, est.isPrimary ? 1 : 0, timestamp, est.id);

                        // Delete removed est_values
                        if (Array.isArray(est.estValuesToDelete)) {
                            for (const delValId of est.estValuesToDelete) {
                                deleteVal.run(delValId);
                            }
                        }

                        // Loop estValues
                        if (Array.isArray(est.estValues)) {
                            for (const val of est.estValues) {
                                if (val.id) {
                                    // Update existing estValue
                                    updateVal.run(
                                        val.name || 'unknown',
                                        val.priceType || null,
                                        val.type || '',
                                        val.pricePer !== undefined ? parseFloat(val.pricePer) : 0,
                                        val.amt !== undefined ? parseFloat(val.amt) : 0,
                                        timestamp,
                                        val.id
                                    );
                                } else {
                                    // Insert new estValue under existing estimate
                                    insertVal.run(
                                        est.id,
                                        val.name || 'unknown',
                                        val.type || '',
                                        val.priceType || null,
                                        val.amt !== undefined ? parseFloat(val.amt) : 0,
                                        val.pricePer !== undefined ? parseFloat(val.pricePer) : 0,
                                        timestamp,
                                        timestamp
                                    );
                                }
                            }
                        }
                    } else {
                        // 2. Insert new estimate
                        const estResult = insertEst.run(
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
                                insertVal.run(
                                    newEstId,
                                    val.name || 'unknown',
                                    val.type || '',
                                    val.priceType || null,
                                    val.pricePer !== undefined ? parseFloat(val.pricePer) : 0,
                                    val.amt !== undefined ? parseFloat(val.amt) : 0,
                                    timestamp,
                                    timestamp
                                );
                            }
                        }
                    }
                }
            }
        });

        transaction();
        const fullSheet = getCustomSheetWithDetails(id);
        return sendSuccess(res, fullSheet);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. DELETE /:id (Delete custom sheet and cascade estimates/estimate values)
router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;

        const sheet = db.prepare('SELECT id FROM custom_sheets WHERE id = ?').get(id);
        if (!sheet) {
            return sendError(res, 'Custom sheet not found', 404);
        }

        const transaction = db.transaction(() => {
            // Find estimates
            const estimates = db.prepare('SELECT id FROM estimates WHERE custom_sheet_id = ?').all(id);
            for (const est of estimates) {
                // Delete estimate values
                db.prepare('DELETE FROM est_values WHERE estimate_id = ?').run(est.id);
            }
            // Delete estimates
            db.prepare('DELETE FROM estimates WHERE custom_sheet_id = ?').run(id);
            // Delete custom sheet
            db.prepare('DELETE FROM custom_sheets WHERE id = ?').run(id);
        });

        transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
