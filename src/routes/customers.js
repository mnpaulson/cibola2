const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { deleteImageFile } = require('../utils/image');
const { sendSuccess, sendError } = require('../utils/response');
const { findAndSaveDuplicatesForCustomer, scanAllDuplicates } = require('../utils/duplicateDetector');

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

// GET /customers/orphans - List customer records without any related jobs/credits/sheets
router.get('/orphans', async (req, res) => {
    try {
        const orphans = await db.prepare(`
            SELECT c.*, 
                   (SELECT COUNT(*) FROM jobs WHERE customer_id = c.id) as job_count,
                   (SELECT COUNT(*) FROM goldcredits WHERE customer_id = c.id) as credit_count,
                   (SELECT COUNT(*) FROM custom_sheets WHERE customer_id = c.id) as custom_sheet_count
            FROM customers c
            WHERE (SELECT COUNT(*) FROM jobs WHERE customer_id = c.id) = 0
              AND (SELECT COUNT(*) FROM goldcredits WHERE customer_id = c.id) = 0
              AND (SELECT COUNT(*) FROM custom_sheets WHERE customer_id = c.id) = 0
            ORDER BY c.id DESC
        `).all();

        return sendSuccess(res, orphans);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// DELETE /customers/orphans/:id - Delete single unused customer record and purge duplicate flags
router.delete('/orphans/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const customer = await db.prepare('SELECT id FROM customers WHERE id = ?').get(id);
        if (!customer) {
            return sendError(res, 'Customer not found', 404);
        }

        const transaction = db.transaction(async () => {
            await db.prepare('DELETE FROM customer_duplicates WHERE customer_id_1 = ? OR customer_id_2 = ?').run(id, id);
            await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
        });

        await transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// POST /customers/orphans/delete-bulk - Bulk delete all (or specified) unused customer records
router.post('/orphans/delete-bulk', async (req, res) => {
    try {
        const { ids } = req.body || {};
        let idsToDelete = ids;

        if (!idsToDelete || !Array.isArray(idsToDelete) || idsToDelete.length === 0) {
            const orphans = await db.prepare(`
                SELECT c.id
                FROM customers c
                WHERE (SELECT COUNT(*) FROM jobs WHERE customer_id = c.id) = 0
                  AND (SELECT COUNT(*) FROM goldcredits WHERE customer_id = c.id) = 0
                  AND (SELECT COUNT(*) FROM custom_sheets WHERE customer_id = c.id) = 0
            `).all();
            idsToDelete = orphans.map(o => o.id);
        }

        if (idsToDelete.length === 0) {
            return sendSuccess(res, { deletedCount: 0 });
        }

        const transaction = db.transaction(async () => {
            for (const id of idsToDelete) {
                await db.prepare('DELETE FROM customer_duplicates WHERE customer_id_1 = ? OR customer_id_2 = ?').run(id, id);
                await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
            }
        });

        await transaction();
        return sendSuccess(res, { deletedCount: idsToDelete.length });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// GET /customers/duplicates - List duplicate pairs by status
router.get('/duplicates', async (req, res) => {
    try {
        const { status = 'unreviewed' } = req.query;
        const pairs = await db.prepare(`
            SELECT d.*, 
                   c1.fname as c1_fname, c1.lname as c1_lname, c1.phone as c1_phone, c1.email as c1_email, c1.addr_st as c1_addr_st, c1.addr_city as c1_addr_city, c1.note as c1_note,
                   c2.fname as c2_fname, c2.lname as c2_lname, c2.phone as c2_phone, c2.email as c2_email, c2.addr_st as c2_addr_st, c2.addr_city as c2_addr_city, c2.note as c2_note
            FROM customer_duplicates d
            JOIN customers c1 ON d.customer_id_1 = c1.id
            JOIN customers c2 ON d.customer_id_2 = c2.id
            WHERE d.status = ?
            ORDER BY d.similarity_score DESC, d.updated_at DESC
        `).all(status);

        const formatted = pairs.map(p => ({
            id: p.id,
            customer_id_1: p.customer_id_1,
            customer_id_2: p.customer_id_2,
            similarity_score: p.similarity_score,
            match_reasons: JSON.parse(p.match_reasons || '[]'),
            status: p.status,
            updated_at: p.updated_at,
            customer1: {
                id: p.customer_id_1,
                fname: p.c1_fname,
                lname: p.c1_lname,
                phone: p.c1_phone,
                email: p.c1_email,
                addr_st: p.c1_addr_st,
                addr_city: p.c1_addr_city,
                note: p.c1_note
            },
            customer2: {
                id: p.customer_id_2,
                fname: p.c2_fname,
                lname: p.c2_lname,
                phone: p.c2_phone,
                email: p.c2_email,
                addr_st: p.c2_addr_st,
                addr_city: p.c2_addr_city,
                note: p.c2_note
            }
        }));

        return sendSuccess(res, formatted);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// POST /customers/duplicates/scan - Run batch duplicate detection scan
router.post('/duplicates/scan', async (req, res) => {
    try {
        const stats = await scanAllDuplicates();
        return sendSuccess(res, stats);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// POST /customers/duplicates/:id/reject - Mark duplicate pair as rejected
router.post('/duplicates/:id/reject', async (req, res) => {
    try {
        const { id } = req.params;
        const timestamp = getTimestamp();
        await db.prepare(`UPDATE customer_duplicates SET status = 'rejected', updated_at = ? WHERE id = ?`).run(timestamp, id);
        return sendSuccess(res, { id: parseInt(id), status: 'rejected' });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// POST /customers/duplicates/:id/unreject - Undo rejection
router.post('/duplicates/:id/unreject', async (req, res) => {
    try {
        const { id } = req.params;
        const timestamp = getTimestamp();
        await db.prepare(`UPDATE customer_duplicates SET status = 'unreviewed', updated_at = ? WHERE id = ?`).run(timestamp, id);
        return sendSuccess(res, { id: parseInt(id), status: 'unreviewed' });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// POST /customers/merge - Merge secondary customer into primary customer
router.post('/merge', async (req, res) => {
    try {
        const { primaryId, secondaryId, mergedFields } = req.body;

        if (!primaryId || !secondaryId || primaryId === secondaryId) {
            return sendError(res, 'Invalid primary or secondary customer IDs', 400);
        }

        const pCust = await db.prepare('SELECT id FROM customers WHERE id = ?').get(primaryId);
        const sCust = await db.prepare('SELECT id FROM customers WHERE id = ?').get(secondaryId);

        if (!pCust || !sCust) {
            return sendError(res, 'One or both customer records could not be found', 404);
        }

        const timestamp = getTimestamp();

        const mergeTx = db.transaction(() => {
            // 1. Update primary customer details
            if (mergedFields) {
                db.prepare(`
                    UPDATE customers
                    SET fname = ?, lname = ?, phone = ?, email = ?, addr_st = ?, addr_city = ?, addr_prov = ?, addr_postal = ?, addr_country = ?, note = ?, updated_at = ?
                    WHERE id = ?
                `).run(
                    mergedFields.fname || '',
                    mergedFields.lname || '',
                    mergedFields.phone || null,
                    mergedFields.email || null,
                    mergedFields.addr_st || null,
                    mergedFields.addr_city || null,
                    mergedFields.addr_prov || null,
                    mergedFields.addr_postal || null,
                    mergedFields.addr_country || null,
                    mergedFields.note || null,
                    timestamp,
                    primaryId
                );
            }

            // 2. Re-link associated entities from secondary to primary
            db.prepare('UPDATE jobs SET customer_id = ? WHERE customer_id = ?').run(primaryId, secondaryId);
            db.prepare('UPDATE goldcredits SET customer_id = ? WHERE customer_id = ?').run(primaryId, secondaryId);
            db.prepare('UPDATE custom_sheets SET customer_id = ? WHERE customer_id = ?').run(primaryId, secondaryId);

            // 3. Update duplicate pair entries
            const id1 = Math.min(primaryId, secondaryId);
            const id2 = Math.max(primaryId, secondaryId);
            db.prepare(`
                UPDATE customer_duplicates 
                SET status = 'merged', updated_at = ? 
                WHERE customer_id_1 = ? AND customer_id_2 = ?
            `).run(timestamp, id1, id2);

            // Delete any remaining duplicate entries involving secondaryId
            db.prepare(`
                DELETE FROM customer_duplicates 
                WHERE (customer_id_1 = ? OR customer_id_2 = ?) AND status != 'merged'
            `).run(secondaryId, secondaryId);

            // 4. Delete secondary customer
            db.prepare('DELETE FROM customers WHERE id = ?').run(secondaryId);
        });

        mergeTx();

        // Fetch final merged primary customer
        const mergedCustomer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(primaryId);
        return sendSuccess(res, mergedCustomer);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// GET /customers/:id/duplicates - Show unreviewed duplicates for a specific customer
router.get('/:id/duplicates', async (req, res) => {
    try {
        const { id } = req.params;
        const pairs = await db.prepare(`
            SELECT d.*, 
                   c1.fname as c1_fname, c1.lname as c1_lname, c1.phone as c1_phone, c1.email as c1_email, c1.addr_st as c1_addr_st, c1.note as c1_note,
                   c2.fname as c2_fname, c2.lname as c2_lname, c2.phone as c2_phone, c2.email as c2_email, c2.addr_st as c2_addr_st, c2.note as c2_note
            FROM customer_duplicates d
            JOIN customers c1 ON d.customer_id_1 = c1.id
            JOIN customers c2 ON d.customer_id_2 = c2.id
            WHERE (d.customer_id_1 = ? OR d.customer_id_2 = ?) AND d.status = 'unreviewed'
            ORDER BY d.similarity_score DESC
        `).all(id, id);

        const formatted = pairs.map(p => {
            const isCust1 = p.customer_id_1 == id;
            const otherId = isCust1 ? p.customer_id_2 : p.customer_id_1;
            return {
                id: p.id,
                customer_id_1: p.customer_id_1,
                customer_id_2: p.customer_id_2,
                similarity_score: p.similarity_score,
                match_reasons: JSON.parse(p.match_reasons || '[]'),
                status: p.status,
                otherCustomer: {
                    id: otherId,
                    fname: isCust1 ? p.c2_fname : p.c1_fname,
                    lname: isCust1 ? p.c2_lname : p.c1_lname,
                    phone: isCust1 ? p.c2_phone : p.c1_phone,
                    email: isCust1 ? p.c2_email : p.c1_email,
                    addr_st: isCust1 ? p.c2_addr_st : p.c1_addr_st,
                    note: isCust1 ? p.c2_note : p.c1_note
                }
            };
        });

        return sendSuccess(res, formatted);
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
        
        // Retrieve count of related records
        const jobCount = await db.prepare('SELECT COUNT(*) as count FROM jobs WHERE customer_id = ?').get(id);
        const creditCount = await db.prepare('SELECT COUNT(*) as count FROM goldcredits WHERE customer_id = ?').get(id);
        const customSheetCount = await db.prepare('SELECT COUNT(*) as count FROM custom_sheets WHERE customer_id = ?').get(id);
        
        // Attach counts to the customer details response
        customer.job_count = jobCount ? jobCount.count : 0;
        customer.credit_count = creditCount ? creditCount.count : 0;
        customer.custom_sheet_count = customSheetCount ? customSheetCount.count : 0;
        
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
        
        // Run duplicate detection on candidate records
        try {
            await findAndSaveDuplicatesForCustomer(newCustomer.id);
        } catch (dupErr) {
            console.error('Error finding duplicates on create:', dupErr);
        }

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

        // Run duplicate detection on candidate records
        try {
            await findAndSaveDuplicatesForCustomer(updatedCustomer.id);
        } catch (dupErr) {
            console.error('Error finding duplicates on update:', dupErr);
        }

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
                const images = await db.prepare('SELECT image FROM images WHERE job_id = ?').all(job.id);
                for (const img of images) {
                    deleteImageFile(img.image);
                }
                // Delete job images from database
                await db.prepare('DELETE FROM images WHERE job_id = ?').run(job.id);
            }

            // Delete jobs (ON DELETE CASCADE is defined but this double checks and removes them cleanly)
            await db.prepare('DELETE FROM jobs WHERE customer_id = ?').run(id);

            // Find associated custom sheets and delete their estimates & est_values & custom_images
            const sheets = await db.prepare('SELECT id FROM custom_sheets WHERE customer_id = ?').all(id);
            for (const sheet of sheets) {
                // Fetch associated images and delete their physical files
                const images = await db.prepare('SELECT image FROM images WHERE custom_sheet_id = ?').all(sheet.id);
                for (const img of images) {
                    deleteImageFile(img.image);
                }
                await db.prepare('DELETE FROM images WHERE custom_sheet_id = ?').run(sheet.id);

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
                const creditImages = await db.prepare('SELECT image FROM images WHERE goldcredit_id = ?').all(credit.id);
                for (const img of creditImages) {
                    deleteImageFile(img.image);
                }
                await db.prepare('DELETE FROM images WHERE goldcredit_id = ?').run(credit.id);
                await db.prepare('DELETE FROM credit_items WHERE goldcredit_id = ?').run(credit.id);
            }
            await db.prepare('DELETE FROM goldcredits WHERE customer_id = ?').run(id);

            // Delete duplicate pair entries
            await db.prepare('DELETE FROM customer_duplicates WHERE customer_id_1 = ? OR customer_id_2 = ?').run(id, id);

            // Finally delete the customer
            await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
        });

        await transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// POST /customers/merge-exact (Batch merge all unreviewed duplicate pairs that match 100% on all fields)
router.post('/merge-exact', async (req, res) => {
    try {
        const unreviewedPairs = await db.prepare("SELECT * FROM customer_duplicates WHERE status = 'unreviewed'").all();
        let mergedCount = 0;

        for (const pair of unreviewedPairs) {
            const c1 = await db.prepare('SELECT * FROM customers WHERE id = ?').get(pair.customer_id_1);
            const c2 = await db.prepare('SELECT * FROM customers WHERE id = ?').get(pair.customer_id_2);

            if (!c1 || !c2) {
                await db.prepare("UPDATE customer_duplicates SET status = 'merged', updated_at = ? WHERE id = ?")
                    .run(getTimestamp(), pair.id);
                continue;
            }

            const isFieldExact = (val1, val2) => {
                const norm1 = (val1 || '').trim().toLowerCase();
                const norm2 = (val2 || '').trim().toLowerCase();
                if (!norm1 || !norm2) return true;
                return norm1 === norm2;
            };

            const isPhoneExact = (p1, p2) => {
                const norm1 = (p1 || '').replace(/\D/g, '');
                const norm2 = (p2 || '').replace(/\D/g, '');
                if (!norm1 || !norm2) return true;
                return norm1 === norm2;
            };

            const normFname1 = (c1.fname || '').trim().toLowerCase();
            const normFname2 = (c2.fname || '').trim().toLowerCase();
            const normLname1 = (c1.lname || '').trim().toLowerCase();
            const normLname2 = (c2.lname || '').trim().toLowerCase();

            if (!normFname1 || !normFname2 || !normLname1 || !normLname2 || normFname1 !== normFname2 || normLname1 !== normLname2) {
                continue;
            }

            const phoneOk = isPhoneExact(c1.phone, c2.phone);
            const emailOk = isFieldExact(c1.email, c2.email);
            const stOk = isFieldExact(c1.addr_st, c2.addr_st);
            const cityOk = isFieldExact(c1.addr_city, c2.addr_city);
            const provOk = isFieldExact(c1.addr_prov, c2.addr_prov);
            const postalOk = isFieldExact(c1.addr_postal, c2.addr_postal);
            const countryOk = isFieldExact(c1.addr_country, c2.addr_country);
            const noteOk = isFieldExact(c1.note, c2.note);

            if (phoneOk && emailOk && stOk && cityOk && provOk && postalOk && countryOk && noteOk) {
                const primaryId = c1.id;
                const secondaryId = c2.id;
                const timestamp = getTimestamp();

                const mergedFname = c1.fname || c2.fname;
                const mergedLname = c1.lname || c2.lname;
                const mergedPhone = c1.phone || c2.phone;
                const mergedEmail = c1.email || c2.email;
                const mergedSt = c1.addr_st || c2.addr_st;
                const mergedCity = c1.addr_city || c2.addr_city;
                const mergedProv = c1.addr_prov || c2.addr_prov;
                const mergedPostal = c1.addr_postal || c2.addr_postal;
                const mergedCountry = c1.addr_country || c2.addr_country;
                const mergedNote = c1.note || c2.note;

                await db.prepare(`
                    UPDATE customers
                    SET fname = ?, lname = ?, phone = ?, email = ?, addr_st = ?, addr_city = ?, addr_prov = ?, addr_postal = ?, addr_country = ?, note = ?, updated_at = ?
                    WHERE id = ?
                `).run(
                    mergedFname, mergedLname, mergedPhone, mergedEmail,
                    mergedSt, mergedCity, mergedProv, mergedPostal, mergedCountry,
                    mergedNote, timestamp, primaryId
                );

                await db.prepare('UPDATE jobs SET customer_id = ? WHERE customer_id = ?').run(primaryId, secondaryId);
                await db.prepare('UPDATE goldcredits SET customer_id = ? WHERE customer_id = ?').run(primaryId, secondaryId);
                await db.prepare('UPDATE custom_sheets SET customer_id = ? WHERE customer_id = ?').run(primaryId, secondaryId);
                await db.prepare('DELETE FROM customers WHERE id = ?').run(secondaryId);

                await db.prepare("UPDATE customer_duplicates SET status = 'merged', updated_at = ? WHERE id = ?").run(timestamp, pair.id);
                mergedCount++;
            }
        }

        return sendSuccess(res, { mergedCount });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;

