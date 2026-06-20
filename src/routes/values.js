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
        const goldValRecord = db.prepare("SELECT value1 FROM \"values\" WHERE name = 'GoldCAD' OR name = 'Gold'").get();
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
        const platValRecord = db.prepare("SELECT value1 FROM \"values\" WHERE name = 'PlatCAD' OR name = 'Platinum'").get();
        const platCAD = platValRecord ? parseFloat(platValRecord.value1) || 0 : 0;
        return sendSuccess(res, {
            platCAD
        });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3.5. GET /silver (Get SilverCAD value)
router.get('/silver', (req, res) => {
    try {
        const silverValRecord = db.prepare("SELECT value1 FROM \"values\" WHERE name = 'SilverCAD' OR name = 'Silver'").get();
        const silverCAD = silverValRecord ? parseFloat(silverValRecord.value1) || 0 : 0;
        return sendSuccess(res, {
            silverCAD
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

// Helper to fetch price for a given metal from goldbroker
async function fetchPriceFromGoldbroker(metalSymbol) {
    const url = `https://goldbroker.com/api/spot-prices?metal=${metalSymbol}&currency=CAD&weight_unit=g`;
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP error fetching ${metalSymbol}! Status: ${response.status}`);
    }
    const data = await response.json();
    const items = data._embedded && data._embedded.items;
    if (items && items.length > 0) {
        const latest = items[items.length - 1];
        if (latest && (latest.value || latest.mid)) {
            return latest.value || latest.mid;
        }
    }
    if (data.last_historical_spot_price && data.last_historical_spot_price.close) {
        return data.last_historical_spot_price.close;
    }
    throw new Error(`Unable to extract price for ${metalSymbol} from response`);
}

// 8. POST /sync (Fetch and update metal prices)
router.post('/sync', async (req, res) => {
    try {
        const timestamp = getTimestamp();

        // 1. Fetch prices in parallel
        const [goldPrice, silverPrice, platPrice] = await Promise.all([
            fetchPriceFromGoldbroker('XAU'),
            fetchPriceFromGoldbroker('XAG'),
            fetchPriceFromGoldbroker('XPT')
        ]);

        // Helper function to upsert a metal price record
        const upsertPrice = (name, oldNames, price) => {
            const queryNames = [name, ...oldNames];
            const placeholders = queryNames.map(() => '?').join(',');
            
            // Check if record exists
            const existing = db.prepare(`
                SELECT id, name FROM "values" 
                WHERE type_id = 2 AND name IN (${placeholders})
            `).get(...queryNames);

            if (existing) {
                // Update existing record, setting name to the clean name if it was old
                db.prepare(`
                    UPDATE "values" 
                    SET name = ?, value1 = ?, updated_at = ? 
                    WHERE id = ?
                `).run(name, price.toString(), timestamp, existing.id);
            } else {
                // Find max order to place it nicely
                const maxOrderRec = db.prepare(`SELECT MAX(CAST("order" AS INTEGER)) as maxOrder FROM "values"`).get();
                const nextOrder = (maxOrderRec && maxOrderRec.maxOrder ? parseInt(maxOrderRec.maxOrder) : 0) + 1;

                db.prepare(`
                    INSERT INTO "values" (type_id, name, value1, "order", active, created_at, updated_at)
                    VALUES (2, ?, ?, ?, 1, ?, ?)
                `).run(name, price.toString(), nextOrder.toString(), timestamp, timestamp);
            }
        };

        // 2. Perform updates inside a transaction
        const syncTransaction = db.transaction(() => {
            upsertPrice('GoldCAD', ['Gold'], goldPrice);
            upsertPrice('SilverCAD', ['Silver'], silverPrice);
            upsertPrice('PlatCAD', ['Platinum'], platPrice);
        });
        
        syncTransaction();

        return sendSuccess(res, {
            GoldCAD: goldPrice,
            SilverCAD: silverPrice,
            PlatCAD: platPrice,
            timestamp
        });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
