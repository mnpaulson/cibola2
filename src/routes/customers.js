const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { deleteImageFile } = require('../utils/image');
const { sendSuccess, sendError } = require('../utils/response');

// 1. GET /customers (List, Recent, or Search)
router.get('/', async (req, res) => {
    try {
        const { type, q } = req.query;
        let customers;

        if (q) {
            const tokens = q.trim().split(/\s+/).filter(Boolean);
            if (tokens.length > 0) {
                let sql = 'SELECT id, fname, lname, phone, email, addr_st, addr_city, addr_prov, addr_postal, addr_country FROM customers WHERE ';
                const tokenGroups = [];
                const params = [];
                
                for (const token of tokens) {
                    const tokenConditions = [];
                    // 1. Substring matches
                    tokenConditions.push('(fname LIKE ? OR lname LIKE ? OR phone LIKE ?)');
                    params.push(`%${token}%`, `%${token}%`, `%${token}%`);
                    
                    // 2. Prefix matches for spelling mistake fallback (if token length >= 2)
                    if (token.length >= 2) {
                        let prefix;
                        if (token.length >= 5) {
                            prefix = token.slice(0, token.length - 2);
                        } else if (token.length >= 3) {
                            prefix = token.slice(0, token.length - 1);
                        } else {
                            prefix = token;
                        }
                        tokenConditions.push('(fname LIKE ? OR lname LIKE ?)');
                        params.push(`${prefix}%`, `${prefix}%`);
                    }
                    
                    tokenGroups.push(`(${tokenConditions.join(' OR ')})`);
                }
                
                sql += tokenGroups.join(' AND ') + ' ORDER BY lname ASC, fname ASC LIMIT 100';
                customers = await db.prepare(sql).all(...params);
            } else {
                customers = [];
            }
        } else if (type === 'recent') {
            customers = await db.prepare('SELECT id, fname, lname, phone, email, addr_st, addr_city, addr_prov, addr_postal, addr_country, created_at, updated_at FROM customers ORDER BY updated_at DESC LIMIT 10').all();
        } else if (type === 'search') {
            customers = await db.prepare('SELECT id, fname, lname, phone FROM customers').all();
        } else {
            customers = await db.prepare('SELECT id, fname, lname, phone, email, addr_st, addr_city, addr_prov, addr_postal, addr_country, created_at, updated_at FROM customers').all();
        }

        return sendSuccess(res, customers);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /customers/:id (Show single customer)
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
        
        if (!customer) {
            return sendError(res, 'Customer not found', 404);
        }
        
        return sendSuccess(res, customer);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. POST /customers (Store/Create customer)
router.post('/', async (req, res) => {
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
        
        const result = await insert.run(
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

        const newCustomer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid);
        return sendSuccess(res, newCustomer, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. PUT /customers/:id (Update customer)
router.put('/:id', async (req, res) => {
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
        
        const result = await update.run(
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

        const updatedCustomer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
        return sendSuccess(res, updatedCustomer);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. DELETE /customers/:id (Delete customer and related files/db rows via cascade)
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Check if customer exists first
        const customer = await db.prepare('SELECT id FROM customers WHERE id = ?').get(id);
        if (!customer) {
            return sendError(res, 'Customer not found', 404);
        }

        const transaction = db.transaction(async () => {
            // Find associated jobs to clean up their image files
            const jobs = await db.prepare('SELECT id FROM jobs WHERE customer_id = ?').all(id);
            for (const job of jobs) {
                const images = await db.prepare('SELECT image FROM job_images WHERE job_id = ?').all(job.id);
                for (const img of images) {
                    deleteImageFile(img.image);
                }
                // Delete job images from database
                await db.prepare('DELETE FROM job_images WHERE job_id = ?').run(job.id);
            }

            // Delete jobs (ON DELETE CASCADE is defined but this double checks and removes them cleanly)
            await db.prepare('DELETE FROM jobs WHERE customer_id = ?').run(id);

            // Find associated custom sheets and delete their estimates & est_values & custom_images
            const sheets = await db.prepare('SELECT id FROM custom_sheets WHERE customer_id = ?').all(id);
            for (const sheet of sheets) {
                // Fetch associated images and delete their physical files
                const images = await db.prepare('SELECT image FROM custom_images WHERE custom_sheet_id = ?').all(sheet.id);
                for (const img of images) {
                    deleteImageFile(img.image);
                }
                await db.prepare('DELETE FROM custom_images WHERE custom_sheet_id = ?').run(sheet.id);

                const estimates = await db.prepare('SELECT id FROM estimates WHERE custom_sheet_id = ?').all(sheet.id);
                for (const est of estimates) {
                    await db.prepare('DELETE FROM est_values WHERE estimate_id = ?').run(est.id);
                }
                await db.prepare('DELETE FROM estimates WHERE custom_sheet_id = ?').run(sheet.id);
            }
            await db.prepare('DELETE FROM custom_sheets WHERE customer_id = ?').run(id);

            // Find associated goldcredits to clean up items and images
            const credits = await db.prepare('SELECT id FROM goldcredits WHERE customer_id = ?').all(id);
            for (const credit of credits) {
                const creditImages = await db.prepare('SELECT image FROM credit_images WHERE goldcredit_id = ?').all(credit.id);
                for (const img of creditImages) {
                    deleteImageFile(img.image);
                }
                await db.prepare('DELETE FROM credit_images WHERE goldcredit_id = ?').run(credit.id);
                await db.prepare('DELETE FROM credit_items WHERE goldcredit_id = ?').run(credit.id);
            }
            await db.prepare('DELETE FROM goldcredits WHERE customer_id = ?').run(id);

            // Finally delete the customer
            await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
        });

        await transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
