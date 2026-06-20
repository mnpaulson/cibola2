# Developer Guide: Updating Frontend to Align with `est_values` Table Changes

The backend has updated the database schema and API routes for the `est_values` table to align exactly with the old MySQL/MariaDB database. The legacy column name `pricePer` has been dropped, and the new structure relies on four distinct pricing columns.

> [!WARNING]
> There is **no backward compatibility** or fallback name-mapping on the backend. The API will strictly expect and return the new database columns. The frontend **must** be updated to map to these new fields.

---

## 1. Summary of Column Changes

The `est_values` table uses the following schema:

| Old Frontend Field | New Database Field | SQLite Type | Purpose |
|---|---|---|---|
| `pricePer` | `basePrice` | `REAL` | Base/labor price per unit before any modifier |
| *None* | `markup` | `REAL` | Multiplier factor (default: `0.00`) |
| *None* | `discount` | `REAL` | Value subtracted (default: `0.00`) |
| *None* | `priceModifier` | `REAL` | Dynamic adjustments (default: `0.00`) |

---

## 2. Steps to Update the Vue Frontend

To update the frontend client (specifically [CustomSheetForm.vue](file:///C:/dev/Cibola2-Electron/src/components/CustomSheetForm.vue)), follow these steps:

### Step 2.1: Update Payload Generation
In `CustomSheetForm.vue` -> `preparePayload()`, stop sending `pricePer` and send `basePrice`, `markup`, `discount`, and `priceModifier` instead:

```javascript
      estValues: est.estValues.map(val => ({
        id: typeof val.id === 'string' && val.id.startsWith('clientId-') ? null : val.id,
        name: val.name || 'unknown',
        type: val.type,
        priceType: val.priceType || null,
        amt: parseFloat(val.amt) || 0,
        basePrice: parseFloat(val.basePrice) || 0,
        markup: parseFloat(val.markup) || 0,
        discount: parseFloat(val.discount) || 0,
        priceModifier: parseFloat(val.priceModifier) || 0
      }))
```

### Step 2.2: Update Object Initialization
In `addEmptyItem`, `addExtraItem`, `copyActiveEstimate`, and `loadSheet` (the mapper loop), update the structures to initialize the new properties. Rename `pricePer` references to `basePrice`:

```javascript
// Example in addEmptyItem:
function addEmptyItem(est, category) {
  est.estValues.push({
    id: `clientId-${estValIdCounter++}`,
    type: category,
    name: '',
    amt: '1',
    basePrice: 0,
    markup: 0,
    discount: 0,
    priceModifier: 0,
    priceType: '',
    selectedOption: null,
    formula: 'BaseOnly',
    isManualOverride: false
  })
}
```

### Step 2.3: Update Calculations and Component Models
Update `calculateItemTotal`, `recalculateItem`, and the manual price triggers to use the new fields to compute the final price.
For example:
```javascript
function calculateItemTotal(val) {
  const amt = parseFloat(val.amt) || 0
  const base = parseFloat(val.basePrice) || 0
  const markup = parseFloat(val.markup) || 0
  const discount = parseFloat(val.discount) || 0
  const modifier = parseFloat(val.priceModifier) || 0

  // Standard pricing formula logic:
  // Apply markup/discount/modifier to the base price as defined by the application requirements
  // e.g. base * (1 + markup) - discount + modifier
  const calculatedPricePer = base * (markup || 1) - discount + modifier;
  return Math.round(amt * calculatedPricePer * 100) / 100
}
```
If the frontend UI wants to present a "Price Per" read-only field computed from these inputs, map it reactively inside the item loop.
