const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { deleteImageFile } = require('../utils/image');
const { sendSuccess, sendError } = require('../utils/response');

// 1. GET /customers (List, Recent, or Search)
router.get('/', (req, res) => {
    try {
        const { type } = req.query;
        let customers;

        if (type === 'recent') {
            customers = db.prepare('SELECT * FROM customers ORDER BY updated_at DESC LIMIT 10').all();
        } else if (type === 'search') {
            customers = db.prepare('SELECT id, fname, lname, phone FROM customers').all();
        } else {
            customers = db.prepare('SELECT * FROM customers').all();
        }

        return sendSuccess(res, customers);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /customers/:id (Show single customer)
router.get('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
        
        if (!customer) {
            return sendError(res, 'Customer not found', 404);
        }
        
        return sendSuccess(res, customer);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. POST /customers (Store/Create customer)
router.post('/', (req, res) => {
    try {
        const { fname, lname, phone, email, addr_st, addr_city, addr_prov, addr_postal, addr_country, note } = req.body;
        
        if (!fname || !lname) {
            return sendError(res, 'First name and last name are required', 400);
        }

        const timestamp = getTimestamp();

        const insert = db.prepare(`
            INSERT INTO customers (fname, lname, phone, email, addr_st, addr_city, addr_prov, addr_postal, addr_country, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const result = insert.run(
            fname,
            lname,
            phone || null,
            email || null,
            addr_st || null,
            addr_city || null,
            addr_prov || null,
            addr_postal || null,
            addr_country || null,
            note || null,
            timestamp,
            timestamp
        );

        const newCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid);
        return sendSuccess(res, newCustomer, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. PUT /customers/:id (Update customer)
router.put('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { fname, lname, phone, email, addr_st, addr_city, addr_prov, addr_postal, addr_country, note } = req.body;

        if (!fname || !lname) {
            return sendError(res, 'First name and last name are required', 400);
        }

        const timestamp = getTimestamp();

        const update = db.prepare(`
            UPDATE customers
            SET fname = ?, lname = ?, phone = ?, email = ?, addr_st = ?, addr_city = ?, addr_prov = ?, addr_postal = ?, addr_country = ?, note = ?, updated_at = ?
            WHERE id = ?
        `);
        
        const result = update.run(
            fname,
            lname,
            phone || null,
            email || null,
            addr_st || null,
            addr_city || null,
            addr_prov || null,
            addr_postal || null,
            addr_country || null,
            note || null,
            timestamp,
            id
        );

        if (result.changes === 0) {
            return sendError(res, 'Customer not found', 404);
        }

        const updatedCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
        return sendSuccess(res, updatedCustomer);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. DELETE /customers/:id (Delete customer and related files/db rows via cascade)
router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;

        // Check if customer exists first
        const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(id);
        if (!customer) {
            return sendError(res, 'Customer not found', 404);
        }

        const transaction = db.transaction(() => {
            // Find associated jobs to clean up their image files
            const jobs = db.prepare('SELECT id FROM jobs WHERE customer_id = ?').all(id);
            for (const job of jobs) {
                const images = db.prepare('SELECT image FROM job_images WHERE job_id = ?').all(job.id);
                for (const img of images) {
                    deleteImageFile(img.image);
                }
                // Delete job images from database
                db.prepare('DELETE FROM job_images WHERE job_id = ?').run(job.id);
            }

            // Delete jobs (ON DELETE CASCADE is defined but this double checks and removes them cleanly)
            db.prepare('DELETE FROM jobs WHERE customer_id = ?').run(id);

            // Find associated custom sheets and delete their estimates & est_values
            const sheets = db.prepare('SELECT id FROM custom_sheets WHERE customer_id = ?').all(id);
            for (const sheet of sheets) {
                const estimates = db.prepare('SELECT id FROM estimates WHERE custom_sheet_id = ?').all(sheet.id);
                for (const est of estimates) {
                    db.prepare('DELETE FROM est_values WHERE estimate_id = ?').run(est.id);
                }
                db.prepare('DELETE FROM estimates WHERE custom_sheet_id = ?').run(sheet.id);
            }
            db.prepare('DELETE FROM custom_sheets WHERE customer_id = ?').run(id);

            // Find associated goldcredits to clean up items and images
            const credits = db.prepare('SELECT id FROM goldcredits WHERE customer_id = ?').all(id);
            for (const credit of credits) {
                const creditImages = db.prepare('SELECT image FROM credit_images WHERE goldcredit_id = ?').all(credit.id);
                for (const img of creditImages) {
                    deleteImageFile(img.image);
                }
                db.prepare('DELETE FROM credit_images WHERE goldcredit_id = ?').run(credit.id);
                db.prepare('DELETE FROM credit_items WHERE goldcredit_id = ?').run(credit.id);
            }
            db.prepare('DELETE FROM goldcredits WHERE customer_id = ?').run(id);

            // Finally delete the customer
            db.prepare('DELETE FROM customers WHERE id = ?').run(id);
        });

        transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
