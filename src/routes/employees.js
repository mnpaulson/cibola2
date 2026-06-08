const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { sendSuccess, sendError } = require('../utils/response');

// 1. GET /employees (List all or active only)
router.get('/', (req, res) => {
    try {
        const { active } = req.query;
        let employees;

        if (active === 'true') {
            employees = db.prepare('SELECT * FROM employees WHERE active = 1').all();
        } else {
            employees = db.prepare('SELECT * FROM employees').all();
        }

        return sendSuccess(res, employees);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /employees/outstanding (List active employees with outstanding jobs)
router.get('/outstanding', (req, res) => {
    try {
        const { sort } = req.query;
        const employees = db.prepare('SELECT id, name FROM employees WHERE active = 1').all();

        // Build sorting clause based on "sort" parameter
        // Default (jobs): ordered by due_date ASC
        // Stats: ordered by vital_date ASC, due_date DESC
        const orderByClause = sort === 'vital' 
            ? 'ORDER BY vital_date ASC, due_date DESC' 
            : 'ORDER BY due_date ASC';

        for (const emp of employees) {
            const jobs = db.prepare(`
                SELECT id, estimate, due_date, completed_at, employee_id, customer_id, vital_date
                FROM jobs
                WHERE employee_id = ? AND completed_at IS NULL
                ${orderByClause}
            `).all(emp.id);

            for (const job of jobs) {
                const customer = db.prepare(`
                    SELECT id, (fname || ' ' || lname) as name
                    FROM customers
                    WHERE id = ?
                `).get(job.customer_id);
                job.customer = customer || null;
            }

            emp.jobs = jobs;
        }

        return sendSuccess(res, employees);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. GET /employees/:id (Show single employee)
router.get('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);

        if (!employee) {
            return sendError(res, 'Employee not found', 404);
        }

        return sendSuccess(res, employee);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. POST /employees (Create employee)
router.post('/', (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return sendError(res, 'Employee name is required', 400);
        }

        const timestamp = getTimestamp();

        const insert = db.prepare('INSERT INTO employees (name, active, created_at, updated_at) VALUES (?, 1, ?, ?)');
        const result = insert.run(name, timestamp, timestamp);

        const newEmployee = db.prepare('SELECT * FROM employees WHERE id = ?').get(result.lastInsertRowid);
        return sendSuccess(res, newEmployee, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. PUT /employees/:id (Update employee)
router.put('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { name, active } = req.body;

        if (!name) {
            return sendError(res, 'Employee name is required', 400);
        }

        const timestamp = getTimestamp();
        const activeVal = active === false || active === 0 ? 0 : 1;

        const update = db.prepare('UPDATE employees SET name = ?, active = ?, updated_at = ? WHERE id = ?');
        const result = update.run(name, activeVal, timestamp, id);

        if (result.changes === 0) {
            return sendError(res, 'Employee not found', 404);
        }

        const updatedEmployee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
        return sendSuccess(res, updatedEmployee);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 6. DELETE /employees/:id (Delete employee and reassign outstanding jobs/credits to ID 1)
router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;

        if (parseInt(id) === 1) {
            return sendError(res, 'You cannot delete employee 1 (Unassigned)', 400);
        }

        // Check if employee exists
        const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(id);
        if (!employee) {
            return sendError(res, 'Employee not found', 404);
        }

        const transaction = db.transaction(() => {
            // Reassign outstanding jobs to employee 1
            const updateJobs = db.prepare('UPDATE jobs SET employee_id = 1 WHERE employee_id = ?');
            updateJobs.run(id);

            // Reassign goldcredits to employee 1
            const updateCredits = db.prepare('UPDATE goldcredits SET employee_id = 1 WHERE employee_id = ?');
            updateCredits.run(id);

            // Destroy employee
            db.prepare('DELETE FROM employees WHERE id = ?').run(id);
        });

        transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
