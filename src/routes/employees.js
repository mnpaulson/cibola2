const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { sendSuccess, sendError } = require('../utils/response');

// 1. GET /employees (List all or active only, with optional exclusion of Nobody/Unassigned)
router.get('/', async (req, res) => {
    try {
        const { active, excludeNobody } = req.query;
        let query = 'SELECT * FROM employees';
        const conditions = [];

        if (active === 'true') {
            conditions.push('active = 1');
        }
        if (excludeNobody === 'true') {
            conditions.push("id != 1 AND name != 'Nobody' AND name != 'Unassigned'");
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        const employees = await db.prepare(query).all();
        return sendSuccess(res, employees);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /employees/assignable (List active employees excluding system default / 'Nobody')
router.get('/assignable', async (req, res) => {
    try {
        const employees = await db.prepare("SELECT * FROM employees WHERE active = 1 AND id != 1 AND name != 'Nobody' AND name != 'Unassigned'").all();
        return sendSuccess(res, employees);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. GET /employees/:id (Show single employee)
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(id);

        if (!employee) {
            return sendError(res, 'Employee not found', 404);
        }

        return sendSuccess(res, employee);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. POST /employees (Create employee)
router.post('/', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return sendError(res, 'Employee name is required', 400);
        }

        const timestamp = getTimestamp();

        const insert = db.prepare('INSERT INTO employees (name, active, created_at, updated_at) VALUES (?, 1, ?, ?)');
        const result = await insert.run(name, timestamp, timestamp);

        const newEmployee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(result.lastInsertRowid);
        return sendSuccess(res, newEmployee, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. PUT /employees/:id (Update employee)
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, active } = req.body;

        if (!name) {
            return sendError(res, 'Employee name is required', 400);
        }

        const timestamp = getTimestamp();
        const activeVal = active === false || active === 0 ? 0 : 1;

        const update = db.prepare('UPDATE employees SET name = ?, active = ?, updated_at = ? WHERE id = ?');
        const result = await update.run(name, activeVal, timestamp, id);

        if (result.changes === 0) {
            return sendError(res, 'Employee not found', 404);
        }

        const updatedEmployee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
        return sendSuccess(res, updatedEmployee);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 6. DELETE /employees/:id (Delete employee and reassign outstanding jobs/credits to ID 1)
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (parseInt(id) === 1) {
            return sendError(res, 'You cannot delete employee 1 (Unassigned)', 400);
        }

        // Check if employee exists
        const employee = await db.prepare('SELECT id FROM employees WHERE id = ?').get(id);
        if (!employee) {
            return sendError(res, 'Employee not found', 404);
        }

        const transaction = db.transaction(async () => {
            // Reassign outstanding jobs to employee 1
            const updateJobs = db.prepare('UPDATE jobs SET employee_id = 1 WHERE employee_id = ?');
            await updateJobs.run(id);

            // Reassign goldcredits to employee 1
            const updateCredits = db.prepare('UPDATE goldcredits SET employee_id = 1 WHERE employee_id = ?');
            await updateCredits.run(id);

            // Destroy employee
            await db.prepare('DELETE FROM employees WHERE id = ?').run(id);
        });

        await transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
