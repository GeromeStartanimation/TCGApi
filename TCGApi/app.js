const express = require('express')
const app = express()
app.use(express.json())
const port = 3000

const { MongoClient } = require("mongodb");
// Replace the uri string with your connection string
const uri = "mongodb://localhost:27017/";
const client = new MongoClient(uri);

const database = client.db('tcg');
const users = database.collection('users');


app.get('/users/:username', async (request, response) => {

    try {

        const username = request.params.username;
        await ReadUser(response, username);
    }

    catch (error){

        console.log(error.message);

        response.json({

            success: false,
            status: 500,
            data: "",
            error: "Database Error"
        });
    }

})

app.post('/users/create', async (request, response) => {

    try {

        const json = request.body;

        console.log(request);

        const doc = json;

        const result = await users.insertOne(doc);

        response.json(doc);
    }

    catch (error) {

        console.log(error.message);

        response.status(500).json({

            success: false,
            status: 500,
            data: "",
            error: "Database Error"
        });
    }

})

app.post('/users/rewards/gain/:userID', async (req, res) => {
    try {
        const userID = req.params.userID;
        const { type, reward } = req.body;

        // Parse inner payload (string or object)
        let payload;

        try {
            payload = (typeof reward === 'string') ? JSON.parse(reward) : reward;
        } catch {
            return res.status(400).json({ success: false, status: 400, data: "", error: "Invalid JSON in 'reward'" });
        }

        // ----- CARD REWARD -----
        if (type === 'card') {
            // Accept either a single card or an array of cards
            // Shape: { tid: string, variant?: string, quantity?: number }
            const cards = Array.isArray(payload) ? payload : [payload];

            // Basic validation
            for (const c of cards) {
                if (!c || !c.tid) {
                    return res.status(400).json({ success: false, status: 400, data: "", error: "Invalid card payload (missing 'tid')" });
                }
            }

            // Load user
            const user = await users.findOne({ id: userID });
            if (!user) {
                return res.status(404).json({ success: false, status: 404, data: "", error: "User not found" });
            }

            // Merge cards (by tid + variant)
            const existing = Array.isArray(user.cards) ? [...user.cards] : [];
            const indexOf = (arr, tid, variant) => arr.findIndex(c => c.tid === tid && c.variant === (variant ?? ''));

            for (const c of cards) {
                const variant = c.variant ?? '';           // default blank variant (your model allows "")
                const qty = Math.max(1, Number(c.quantity ?? 1));

                const i = indexOf(existing, c.tid, variant);
                if (i >= 0) {
                    existing[i].quantity = (existing[i].quantity || 0) + qty;
                } else {
                    existing.push({ tid: c.tid, variant, quantity: qty });
                }
            }

            const updatedUser = await users.findOneAndUpdate(
                { id: userID },
                { $set: { cards: existing } },
                { new: true }
            );

            return res.json({ success: true, status: 200, data: updatedUser, error: "" });
        }

        // ----- DECK REWARD (unchanged behavior except for parsing above) -----
        if (type === 'deck') {
            // Validate a UserDeckData-shaped object
            if (!payload || !payload.tid || !payload.title || !payload.hero || !Array.isArray(payload.cards)) {
                return res.status(400).json({ success: false, status: 400, data: "", error: "Invalid deck payload" });
            }

            // 1) Load user
            const user = await users.findOne({ id: userID });
            if (!user) {
                return res.status(404).json({ success: false, status: 404, data: "", error: "User not found" });
            }

            // 2) Prevent duplicate deck tid (same as before)
            const alreadyHasDeck = Array.isArray(user.decks) && user.decks.some(d => d && d.tid === payload.tid);
            if (alreadyHasDeck) {
                return res.status(409).json({ success: false, status: 409, data: "", error: "Deck already owned" });
            }

            // 3) Merge deck.cards into user.cards (increment quantity for same tid+variant)
            const existing = Array.isArray(user.cards) ? [...user.cards] : [];
            const indexOf = (arr, tid, variant) => arr.findIndex(c => c.tid === tid && c.variant === variant);

            for (const c of payload.cards) {
                if (!c || !c.tid) continue;
                const variant = c.variant ?? '';                    // your model allows "" for default
                const qty = Math.max(1, Number(c.quantity ?? 1));   // default 1

                const i = indexOf(existing, c.tid, variant);
                if (i >= 0) {
                    existing[i].quantity = (existing[i].quantity || 0) + qty;
                } else {
                    existing.push({ tid: c.tid, variant, quantity: qty });
                }
            }

            // Optional: ALSO grant hero as a card (Unity AddDeck doesn't; enable if you want parity to differ)
            // if (payload.hero && payload.hero.tid) {
            //   const hv = payload.hero.variant ?? '';
            //   const hi = indexOf(existing, payload.hero.tid, hv);
            //   if (hi >= 0) existing[hi].quantity = (existing[hi].quantity || 0) + 1;
            //   else existing.push({ tid: payload.hero.tid, variant: hv, quantity: 1 });
            // }

            // 4) Append deck to decks
            const newDecks = [...(user.decks || []), payload];

            // 5) Persist both updates atomically
            const updatedUser = await users.findOneAndUpdate(
                { id: userID },
                { $set: { cards: existing, decks: newDecks } },
                { new: true }
            );

            return res.json({ success: true, status: 200, data: updatedUser, error: "" });
        }


        // Unknown reward type
        return res.status(400).json({ success: false, status: 400, data: "", error: `Invalid reward type '${type}'` });

    } catch (err) {
        console.log(err);
        return res.status(500).json({ success: false, status: 500, data: "", error: "Database Error" });
    }
});

app.post('/users/cards/buy/:userID', async (request, response) => {
    try {
        const userID = request.params.userID;
        let { card, variant, quantity, totalCost, unitPrice } = request.body; // card = tid

        // --- minimal input normalization ---
        if (!card || typeof card !== 'string') {
            return response.status(400).json({ success: false, status: 400, data: "", error: "Missing or invalid 'card' (tid)" });
        }
        variant = (typeof variant === 'string') ? variant : "";
        quantity = parseInt(quantity, 10);
        if (isNaN(quantity) || quantity <= 0) quantity = 1;

        // prefer totalCost; fallback to unitPrice*quantity if provided
        totalCost = Number(totalCost);
        if (isNaN(totalCost)) {
            unitPrice = Number(unitPrice);
            totalCost = !isNaN(unitPrice) ? unitPrice * quantity : 0;
        }

        // --- load user ---
        const user = await users.findOne({ id: userID });
        if (!user) {
            return response.status(404).json({ success: false, status: 404, data: "", error: "No User Found" });
        }

        // NOTE: per your request, no server-side guard if coins < totalCost.
        const currentCoins = Number(user.coins) || 0;
        const newCoins = currentCoins - totalCost;

        // --- merge card into user.cards (stack by tid+variant) ---
        const cards = Array.isArray(user.cards) ? [...user.cards] : [];
        const idx = cards.findIndex(c => c.tid === card && (c.variant ?? "") === variant);
        if (idx >= 0) {
            cards[idx].quantity = (cards[idx].quantity || 0) + quantity;
        } else {
            cards.push({ tid: card, variant, quantity });
        }

        // --- persist both updates in one write ---
        const updatedUser = await users.findOneAndUpdate(
            { id: userID },
            { $set: { coins: newCoins, cards } },
            { new: true }
        );

        return response.json({ success: true, status: 200, data: updatedUser, error: "" });

    } catch (error) {
        console.log(error.message);
        return response.status(500).json({ success: false, status: 500, data: "", error: "Database Error" });
    }
});

app.post('/users/cards/sell/:userID', async (req, res) => {
    try {
        const userID = req.params.userID;
        let { card, variant, quantity, totalCost } = req.body; // reuse totalCost as "refund" from client

        // --- normalize / validate ---
        if (!card || typeof card !== 'string') {
            return res.status(400).json({ success: false, status: 400, data: "", error: "Missing or invalid 'card' (tid)" });
        }
        variant = (typeof variant === 'string') ? variant : "";
        quantity = parseInt(quantity, 10);
        if (isNaN(quantity) || quantity <= 0) quantity = 1;

        // If the client sends the computed refund (recommended), use it.
        // Otherwise default to 0 (no refund logic on server).
        let refund = Number(totalCost);
        if (isNaN(refund) || refund < 0) refund = 0;

        // --- load user ---
        const user = await users.findOne({ id: userID });
        if (!user) {
            return res.status(404).json({ success: false, status: 404, data: "", error: "No User Found" });
        }

        // --- find the card entry by (tid, variant) ---
        const cards = Array.isArray(user.cards) ? [...user.cards] : [];
        const idx = cards.findIndex(c => c.tid === card && (c.variant ?? "") === variant);

        if (idx < 0 || (cards[idx].quantity || 0) < quantity) {
            // client already guards this, but keeping a sanity check is good practice
            return res.status(409).json({ success: false, status: 409, data: "", error: "Insufficient card quantity" });
        }

        // --- decrement (or remove if hits zero) ---
        const newQty = (cards[idx].quantity || 0) - quantity;
        if (newQty > 0) {
            cards[idx].quantity = newQty;
        } else {
            cards.splice(idx, 1);
        }

        // --- add refund to coins ---
        const newCoins = (Number(user.coins) || 0) + refund;

        // --- persist and return ---
        const updatedUser = await users.findOneAndUpdate(
            { id: userID },
            { $set: { cards, coins: newCoins } },
            { new: true }
        );

        return res.json({ success: true, status: 200, data: updatedUser, error: "" });

    } catch (err) {
        console.log(err);
        return res.status(500).json({ success: false, status: 500, data: "", error: "Database Error" });
    }
});


app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

async function ReadUser(response, username) {

    const query = { "username": username };

    const matchingUser = await users.findOne(query);

    if (matchingUser) {
        response.json(matchingUser);
    }

    else {
        response.status(404).json({

            success: false,
            status: 404,
            data: "",
            error: "No User Found"

        });
    }

}


