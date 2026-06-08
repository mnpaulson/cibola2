const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { sendSuccess, sendError } = require('../utils/response');

// 1. GET / (List values, active, or filtered by type_id)
router.get('/', (req, res) => {
    try {
        const { active, type_id } = req.query;
        let queryStr = 'SELECT * FROM "values"';
        const params = [];
        const conditions = [];

        if (active === 'true') {
            conditions.push('active = 1');
        }
        if (type_id) {
            conditions.push('type_id = ?');
            params.push(type_id);
        }

        if (conditions.length > 0) {
            queryStr += ' WHERE ' + conditions.join(' AND ');
        }

        queryStr += ' ORDER BY CAST("order" AS INTEGER) ASC';

        const values = db.prepare(queryStr).all(...params);
        return sendSuccess(res, values);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /gold (Get GoldCAD value and default exchange rate)
router.get('/gold', (req, res) => {
    try {
        const goldValRecord = db.prepare("SELECT value1 FROM \"values\" WHERE name = 'GoldCAD'").get();
        const goldCAD = goldValRecord ? parseFloat(goldValRecord.value1) || 0 : 0;
        return sendSuccess(res, {
            goldCAD,
            exchangeRate: 1.35
        });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. GET /plat (Get PlatCAD value)
router.get('/plat', (req, res) => {
    try {
        const platValRecord = db.prepare("SELECT value1 FROM \"values\" WHERE name = 'PlatCAD'").get();
        const platCAD = platValRecord ? parseFloat(platValRecord.value1) || 0 : 0;
        return sendSuccess(res, {
            platCAD
        });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. GET /:id (Get single value details)
router.get('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const value = db.prepare('SELECT * FROM "values" WHERE id = ?').get(id);

        if (!value) {
            return sendError(res, 'Value not found', 404);
        }

        return sendSuccess(res, value);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. POST / (Create lookup configuration)
router.post('/', (req, res) => {
    try {
        const { name, type_id, value1, value2, value3, value4, order, active } = req.body;

        if (!name) {
            return sendError(res, 'Value name is required', 400);
        }

        const timestamp = getTimestamp();

        const insert = db.prepare(`
            INSERT INTO "values" (name, type_id, value1, value2, value3, value4, "order", active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = insert.run(
            name,
            type_id || 1,
            value1 || null,
            value2 || null,
            value3 || null,
            value4 || null,
            order || null,
            active === false || active === 0 ? 0 : 1,
            timestamp,
            timestamp
        );

        const newValue = db.prepare('SELECT * FROM "values" WHERE id = ?').get(result.lastInsertRowid);
        return sendSuccess(res, newValue, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 6. PUT /:id (Update lookup configuration)
router.put('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { name, value1, value2, value3, value4, order, active } = req.body;

        if (!name) {
            return sendError(res, 'Value name is required', 400);
        }

        const timestamp = getTimestamp();

        const update = db.prepare(`
            UPDATE "values"
            SET name = ?, value1 = ?, value2 = ?, value3 = ?, value4 = ?, "order" = ?, active = ?, updated_at = ?
            WHERE id = ?
        `);
        const result = update.run(
            name,
            value1 || null,
            value2 || null,
            value3 || null,
            value4 || null,
            order || null,
            active === false || active === 0 ? 0 : 1,
            timestamp,
            id
        );

        if (result.changes === 0) {
            return sendError(res, 'Value not found', 404);
        }

        const updatedValue = db.prepare('SELECT * FROM "values" WHERE id = ?').get(id);
        return sendSuccess(res, updatedValue);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 7. DELETE /:id (Delete lookup configuration)
router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;

        const value = db.prepare('SELECT id FROM "values" WHERE id = ?').get(id);
        if (!value) {
            return sendError(res, 'Value not found', 404);
        }

        db.prepare('DELETE FROM "values" WHERE id = ?').run(id);
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
