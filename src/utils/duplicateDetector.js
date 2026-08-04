const { db } = require('../db');

function normalizeStr(str) {
    return (str || '').trim().toLowerCase();
}

function normalizePhone(phone) {
    return (phone || '').replace(/\D/g, '');
}

function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function calculateSimilarity(custA, custB) {
    let score = 0;
    const reasons = [];

    const phoneA = normalizePhone(custA.phone);
    const phoneB = normalizePhone(custB.phone);
    const emailA = normalizeStr(custA.email);
    const emailB = normalizeStr(custB.email);

    const fnameA = normalizeStr(custA.fname);
    const fnameB = normalizeStr(custB.fname);
    const lnameA = normalizeStr(custA.lname);
    const lnameB = normalizeStr(custB.lname);

    const fullNameA = `${fnameA} ${lnameA}`.trim();
    const fullNameB = `${fnameB} ${lnameB}`.trim();

    // 1. Phone Match
    if (phoneA.length >= 7 && phoneA === phoneB) {
        score += 45;
        reasons.push('Matching Phone');
    }

    // 2. Email Match
    if (emailA.length > 3 && emailA === emailB) {
        score += 45;
        reasons.push('Matching Email');
    }

    // 3. Name Match (Fuzzy & Sensitive Exact)
    if (fullNameA && fullNameB) {
        if (fnameA && lnameA && fnameA === fnameB && lnameA === lnameB) {
            score += 75;
            reasons.push('Exact First & Last Name Match');
        } else if (fullNameA === fullNameB) {
            score += 75;
            reasons.push('Exact Name Match');
        } else {
            const lnameMax = Math.max(lnameA.length, lnameB.length);
            const lnameDist = lnameMax > 0 ? levenshteinDistance(lnameA, lnameB) : 999;
            const lnameRatio = lnameMax > 0 ? (1 - lnameDist / lnameMax) : 0;

            const fnameMax = Math.max(fnameA.length, fnameB.length);
            const fnameDist = fnameMax > 0 ? levenshteinDistance(fnameA, fnameB) : 999;
            const fnameRatio = fnameMax > 0 ? (1 - fnameDist / fnameMax) : 0;

            const fullMax = Math.max(fullNameA.length, fullNameB.length);
            const fullDist = levenshteinDistance(fullNameA, fullNameB);
            const fullRatio = fullMax > 0 ? (1 - fullDist / fullMax) : 0;

            if (lnameA && lnameB && lnameA === lnameB && (fnameDist <= 2 || fnameRatio >= 0.70)) {
                // Exact last name + minor variation/typo in first name (e.g. John Smith vs Jon Smith)
                score += 75;
                reasons.push('Matching Last Name & Similar First Name');
            } else if (fnameA && fnameB && fnameA === fnameB && (lnameDist <= 2 || lnameRatio >= 0.70)) {
                // Exact first name + minor variation/typo in last name (e.g. John Smith vs John Smyth)
                score += 75;
                reasons.push('Matching First Name & Similar Last Name');
            } else if (fullDist <= 2 || fullRatio >= 0.82) {
                // High overall full name similarity (e.g. Jonathon Smith vs Jonathan Smith)
                score += 75;
                reasons.push(`Similar Full Name (${Math.round(fullRatio * 100)}%)`);
            } else if (lnameRatio >= 0.75 && fnameRatio >= 0.70) {
                // Both first and last names are moderately similar
                score += 75;
                reasons.push('Similar First & Last Names');
            } else if (fullRatio >= 0.70) {
                score += Math.round(fullRatio * 60);
                reasons.push(`Similar Name (${Math.round(fullRatio * 100)}%)`);
            }
        }
    }

    // 4. Street Address Match
    const stA = normalizeStr(custA.addr_st);
    const stB = normalizeStr(custB.addr_st);
    if (stA.length > 3 && stB.length > 3) {
        if (stA === stB) {
            score += 20;
            reasons.push('Matching Street Address');
        }
    }

    const finalScore = Math.min(100, score);
    return {
        score: finalScore,
        reasons,
        isDuplicate: finalScore >= 75
    };
}

/**
 * Scan candidate records against a single customer and save/update potential duplicate pairs.
 */
async function findAndSaveDuplicatesForCustomer(customerId) {
    const target = await db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!target) return [];

    const normPhone = normalizePhone(target.phone);
    const normEmail = normalizeStr(target.email);
    const normFname = normalizeStr(target.fname);
    const normLname = normalizeStr(target.lname);

    // Filter candidate customers by phone, email, last name prefix, or first name prefix
    let candidates = [];
    if (normPhone.length >= 7 || normEmail.length > 3 || normLname.length >= 2 || normFname.length >= 2) {
        let sql = 'SELECT * FROM customers WHERE id != ? AND (';
        const clauses = [];
        const params = [customerId];

        if (normPhone.length >= 7) {
            clauses.push('phone LIKE ?');
            params.push(`%${normPhone.slice(-7)}%`);
        }
        if (normEmail.length > 3) {
            clauses.push('LOWER(email) = ?');
            params.push(normEmail);
        }
        if (normLname.length >= 2) {
            clauses.push('LOWER(lname) LIKE ?');
            params.push(`${normLname.slice(0, 2)}%`);
        }
        if (normFname.length >= 2) {
            clauses.push('LOWER(fname) LIKE ?');
            params.push(`${normFname.slice(0, 2)}%`);
        }

        sql += clauses.join(' OR ') + ')';
        candidates = await db.prepare(sql).all(...params);
    }

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const results = [];

    const checkStmt = db.prepare(`
        SELECT status FROM customer_duplicates 
        WHERE (customer_id_1 = ? AND customer_id_2 = ?)
    `);

    const upsertStmt = db.prepare(`
        INSERT INTO customer_duplicates (customer_id_1, customer_id_2, similarity_score, match_reasons, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'unreviewed', ?, ?)
        ON CONFLICT(customer_id_1, customer_id_2) DO UPDATE SET
            similarity_score = excluded.similarity_score,
            match_reasons = excluded.match_reasons,
            updated_at = excluded.updated_at
        WHERE status = 'unreviewed'
    `);

    for (const cand of candidates) {
        const id1 = Math.min(target.id, cand.id);
        const id2 = Math.max(target.id, cand.id);

        // Check existing status; skip if rejected or merged
        const existing = await checkStmt.get(id1, id2);
        if (existing && (existing.status === 'rejected' || existing.status === 'merged')) {
            continue;
        }

        const sim = calculateSimilarity(target, cand);
        if (sim.isDuplicate) {
            await upsertStmt.run(
                id1,
                id2,
                sim.score,
                JSON.stringify(sim.reasons),
                now,
                now
            );
            results.push({
                customer_id_1: id1,
                customer_id_2: id2,
                similarity_score: sim.score,
                match_reasons: sim.reasons
            });
        }
    }

    return results;
}

/**
 * Scan all customer pairs in the database to generate duplicate flags.
 */
async function scanAllDuplicates() {
    const customers = await db.prepare('SELECT * FROM customers ORDER BY id ASC').all();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const checkStmt = db.prepare(`
        SELECT status FROM customer_duplicates 
        WHERE customer_id_1 = ? AND customer_id_2 = ?
    `);

    const upsertStmt = db.prepare(`
        INSERT INTO customer_duplicates (customer_id_1, customer_id_2, similarity_score, match_reasons, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'unreviewed', ?, ?)
        ON CONFLICT(customer_id_1, customer_id_2) DO UPDATE SET
            similarity_score = excluded.similarity_score,
            match_reasons = excluded.match_reasons,
            updated_at = excluded.updated_at
        WHERE status = 'unreviewed'
    `);

    // Candidate pair map (keyed by "id1_id2") to prevent redundant similarity calculations
    const candidatePairs = new Map();

    const phoneMap = new Map();
    const emailMap = new Map();
    const lnamePrefixMap = new Map();
    const fnamePrefixMap = new Map();

    for (const c of customers) {
        const phone = normalizePhone(c.phone);
        if (phone.length >= 7) {
            if (!phoneMap.has(phone)) phoneMap.set(phone, []);
            phoneMap.get(phone).push(c);
        }

        const email = normalizeStr(c.email);
        if (email.length > 3) {
            if (!emailMap.has(email)) emailMap.set(email, []);
            emailMap.get(email).push(c);
        }

        const lnamePrefix = normalizeStr(c.lname).slice(0, 3);
        if (lnamePrefix.length >= 2) {
            if (!lnamePrefixMap.has(lnamePrefix)) lnamePrefixMap.set(lnamePrefix, []);
            lnamePrefixMap.get(lnamePrefix).push(c);
        }

        const fnamePrefix = normalizeStr(c.fname).slice(0, 3);
        if (fnamePrefix.length >= 2) {
            if (!fnamePrefixMap.has(fnamePrefix)) fnamePrefixMap.set(fnamePrefix, []);
            fnamePrefixMap.get(fnamePrefix).push(c);
        }
    }

    const addGroupPairs = (group, isLargeGroup = false) => {
        if (group.length < 2) return;
        if (isLargeGroup && group.length > 50) {
            for (let i = 0; i < group.length; i++) {
                for (let j = i + 1; j < group.length; j++) {
                    const c1 = group[i];
                    const c2 = group[j];
                    const p1 = normalizePhone(c1.phone);
                    const p2 = normalizePhone(c2.phone);
                    const e1 = normalizeStr(c1.email);
                    const e2 = normalizeStr(c2.email);
                    const f1 = normalizeStr(c1.fname);
                    const f2 = normalizeStr(c2.fname);
                    const l1 = normalizeStr(c1.lname);
                    const l2 = normalizeStr(c2.lname);

                    if (
                        (p1 && p2 && p1 === p2) ||
                        (e1 && e2 && e1 === e2) ||
                        (l1 && l2 && l1 === l2) ||
                        (f1.length >= 2 && f2.length >= 2 && l1.length >= 2 && l2.length >= 2 && f1.slice(0, 2) === f2.slice(0, 2) && l1.slice(0, 2) === l2.slice(0, 2))
                    ) {
                        const id1 = Math.min(c1.id, c2.id);
                        const id2 = Math.max(c1.id, c2.id);
                        candidatePairs.set(`${id1}_${id2}`, [c1, c2]);
                    }
                }
            }
            return;
        }

        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                const id1 = Math.min(group[i].id, group[j].id);
                const id2 = Math.max(group[i].id, group[j].id);
                const key = `${id1}_${id2}`;
                if (!candidatePairs.has(key)) {
                    candidatePairs.set(key, [group[i], group[j]]);
                }
            }
        }
    };

    for (const list of phoneMap.values()) addGroupPairs(list, false);
    for (const list of emailMap.values()) addGroupPairs(list, false);
    for (const list of lnamePrefixMap.values()) addGroupPairs(list, true);
    for (const list of fnamePrefixMap.values()) addGroupPairs(list, true);

    let newFlagged = 0;

    for (const [c1, c2] of candidatePairs.values()) {
        const id1 = c1.id;
        const id2 = c2.id;

        const existing = await checkStmt.get(id1, id2);
        if (existing && (existing.status === 'rejected' || existing.status === 'merged')) {
            continue;
        }

        const sim = calculateSimilarity(c1, c2);
        if (sim.isDuplicate) {
            await upsertStmt.run(
                id1,
                id2,
                sim.score,
                JSON.stringify(sim.reasons),
                now,
                now
            );
            newFlagged++;
        }
    }

    return { totalCustomers: customers.length, flaggedPairs: newFlagged };
}

module.exports = {
    calculateSimilarity,
    findAndSaveDuplicatesForCustomer,
    scanAllDuplicates
};
