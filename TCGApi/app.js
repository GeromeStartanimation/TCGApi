// app.js
const express = require('express');
const cors = require('cors');   // <-- added
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json());

// 🔽 added: Open CORS for all origins (needed for Unity / mobile apps)
app.use(cors({ origin: true, credentials: true }));

const port = process.env.PORT || 3000;
const uri = process.env.DB || "mongodb://localhost:27017/";
const client = new MongoClient(uri);

const database = client.db('tcg');
const users = database.collection('users');
const product = database.collection('price_list');

// 🔽 added: import notifyPaymentSuccess so we can call it in pay/success route
const { notifyPaymentSuccess, notifyPaymentProcess } = require('./ws-server');


app.get('/users/:username', async (request, response) => {

    try {

        const username = request.params.username;
        await ReadUser(response, username);
    }

    catch (error) {

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

        console.log('[UserCreateAPI] Body:', request.body);

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

app.post('/users/edit/:userID', async (request, response) => {
    try {

        const userID = request.params.userID;
        let { avatar, cardback } = request.body; // edit user avatar or cardback

        console.log("Editing " + userID + "properties");

        // Build dynamic update object
        const updateFields = {};
        if (avatar) updateFields.avatar = avatar;
        if (cardback) updateFields.cardback = cardback;

        if (Object.keys(updateFields).length === 0) {
            return response.status(400).json({
                success: false,
                status: 400,
                data: "",
                error: "No fields to update"
            });
        }

        const result = await users.updateOne(
            { id: userID },
            { $set: updateFields }
        );

        if (result.matchedCount === 0) {
            return response.status(404).json({
                success: false,
                status: 404,
                data: "",
                error: "No User Found"
            });
        }

        return response.json({
            success: true,
            status: 200,
            data: updateFields,
            message: "User updated successfully"
        });
    }
    catch (error) {
        console.log(error.message);
        return response.status(500).json({
            success: false,
            status: 500,
            data: "",
            error: "Database Error"
        });
    }
});

// Save or update a user deck
app.post('/users/deck/:userID', async (req, res) => {
    try {
        const userID = req.params.userID;
        const deckData = req.body;

        console.log(`[SaveDeckAPI] Incoming request for userID=${userID}`);
        console.log(`[SaveDeckAPI] Deck payload: ${JSON.stringify(deckData)}`);

        const user = await users.findOne({ id: userID });
        if (!user) {
            console.warn(`[SaveDeckAPI] User not found: ${userID}`);
            return res.status(404).json({ success: false, error: "User not found" });
        }

        const decks = Array.isArray(user.decks) ? [...user.decks] : [];
        const idx = decks.findIndex(d => d.tid === deckData.tid);

        if (idx >= 0) {
            console.log(`[SaveDeckAPI] Updating existing deck tid=${deckData.tid}`);
            decks[idx] = deckData;
        } else {
            console.log(`[SaveDeckAPI] Adding new deck tid=${deckData.tid}`);
            decks.push(deckData);
        }

        await users.updateOne({ id: userID }, { $set: { decks } });
        console.log(`[SaveDeckAPI] Saved decks for userID=${userID}, total decks=${decks.length}`);

        return res.json({ success: true, data: decks });
    } catch (err) {
        console.error(`[SaveDeckAPI] Error: ${err.message}`);
        return res.status(500).json({ success: false, error: "Database error" });
    }
});

// Delete a user deck
app.delete('/users/deck/:userID', async (req, res) => {
    try {
        const userID = req.params.userID;
        const { tid } = req.body; // deck_tid sent in body

        if (!tid) {
            return res.status(400).json({ success: false, error: "Missing deck tid" });
        }

        console.log(`[DeleteDeckAPI] Request to delete deck tid=${tid} for user=${userID}`);

        // Validate user
        const user = await users.findOne({ id: userID });
        if (!user) {
            console.warn(`[DeleteDeckAPI] User not found: ${userID}`);
            return res.status(404).json({ success: false, error: "User not found" });
        }

        // Remove the deck with matching tid
        const updated = await users.updateOne(
            { id: userID },
            { $pull: { decks: { tid } } }   // <- removes deck object with matching tid
        );

        if (updated.modifiedCount === 0) {
            console.warn(`[DeleteDeckAPI] No deck found with tid=${tid} for user=${userID}`);
            return res.status(404).json({ success: false, error: "Deck not found" });
        }

        console.log(`[DeleteDeckAPI] Deck tid=${tid} deleted for user=${userID}`);

        // Return updated decks array
        const freshUser = await users.findOne({ id: userID }, { projection: { decks: 1 } });
        return res.json({ success: true, data: freshUser.decks });
    } catch (err) {
        console.error(`[DeleteDeckAPI] Error: ${err.message}`);
        return res.status(500).json({ success: false, error: "Database error" });
    }
});

app.post('/users/rewards/gain/:userID', async (req, res) => {
    try {
        const userID = req.params.userID;
        const { type } = req.body;

        console.log(userID + " requested reward, type: " + type);
        // Support both new fields and legacy "reward" envelope for backward-compat
        const quantity = Number(req.body.quantity ?? 1);
        const flag = req.body.flag || null;
        const rawJson = typeof req.body.json === 'string' ? req.body.json : null;
        const legacy = req.body.reward; // could be object or JSON string (older client)

        // Small helper to load user once we need it
        const loadUser = async (projection = {}) => {
            const user = await users.findOne({ id: userID }, { projection });
            if (!user) {
                res.status(404).json({ success: false, status: 404, data: "", error: "User not found" });
                return null;
            }
            return user;
        };

        // ----- CARD REWARD (kept as-is if you already had it) -----
        if (type === 'card') {
            // Existing card logic here…
            // (No changes included since your request is specifically about "deck")
            return res.status(400).json({ success: false, status: 400, data: "", error: "Card reward branch not implemented in this snippet" });
        }

        if (type === 'pack') {
            console.log("[PACK] Incoming body:", req.body);

            const user = await loadUser({ userPackProgressDatas: 1 });
            console.log("[PACK] Loaded user:", user?._id, user?.username);

            if (!user) {
                console.error("[PACK] No user found for request");
                return;
            }

            const quantity = Number(req.body.quantity ?? 1); // <--- force numeric
            console.log("[PACK] Quantity:", quantity);

            let packName;
            try {
                const extra = JSON.parse(req.body.json || "{}");
                console.log("[PACK] Parsed extra JSON:", extra);
                packName = extra.packName;
            } catch (err) {
                console.error("[PACK] Failed to parse req.body.json:", req.body.json, err);
                return res.status(400).json({
                    success: false,
                    status: 400,
                    data: "",
                    error: "Invalid JSON payload"
                });
            }

            console.log("[PACK] PackName:", packName);
            if (!packName) {
                console.error("[PACK] Missing packName in JSON payload");
                return res.status(400).json({
                    success: false,
                    status: 400,
                    data: "",
                    error: "Missing packName in json field"
                });
            }

            try {
                console.log("[PACK] Attempting DB update: user._id:", user._id,
                    " packName:", packName,
                    " quantity:", quantity);

                let updateQuery;

                if (quantity === -1) {
                    updateQuery = { $set: { "userPackProgressDatas.$[elem].pullCount": 0 } };
                } else {
                    updateQuery = { $inc: { "userPackProgressDatas.$[elem].pullCount": quantity } };
                }

                const result = await users.updateOne(
                    { _id: user._id },
                    updateQuery,
                    { arrayFilters: [{ "elem.packName": packName }] }
                );

                console.log("[PACK] Update result:", result);

                return res.json({
                    success: true,
                    status: 200,
                    data: { packName, quantity, modified: result.modifiedCount },
                    error: ""
                });
            } catch (err) {
                console.error("[PACK] Database error during update:", err);
                return res.status(500).json({
                    success: false,
                    status: 500,
                    data: "",
                    error: "Database error"
                });
            }
        }





        // ----- COIN REWARD (compatible with your new struct, if you want to keep it here) -----
        if (type === 'coin') {
            const amount = Number.isFinite(quantity) ? quantity : Number(req.body.quantity);
            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({ success: false, status: 400, data: "", error: "Invalid coin amount" });
            }

            const user = await loadUser({ rewards: 1 });
            if (!user) return;

            if (flag && Array.isArray(user.rewards) && user.rewards.includes(flag)) {
                return res.status(409).json({ success: false, status: 409, data: "", error: "Reward already claimed" });
            }

            const update = { $inc: { coins: amount } };
            if (flag) update.$addToSet = { rewards: flag };

            const updatedUser = await users.findOneAndUpdate(
                { id: userID },
                update,
                { returnDocument: 'after' }
            );

            return res.json({ success: true, status: 200, data: updatedUser, error: "" });
        }

        // ----- DECK REWARD (updated to use json + quantity + flag) -----
        if (type === 'deck') {
            // 1) Parse the deck payload
            let deckPayload = null;
            try {
                if (rawJson) {
                    deckPayload = JSON.parse(rawJson);
                } else if (legacy) {
                    deckPayload = (typeof legacy === 'string') ? JSON.parse(legacy) : legacy;
                }
            } catch (e) {
                return res.status(400).json({ success: false, status: 400, data: "", error: "Invalid JSON in 'json' or 'reward'" });
            }

            if (!deckPayload || !deckPayload.tid || !deckPayload.title || !deckPayload.hero || !Array.isArray(deckPayload.cards)) {
                return res.status(400).json({ success: false, status: 400, data: "", error: "Invalid deck payload" });
            }

            // 2) Load user and check idempotency via flag (optional)
            const user = await loadUser({ rewards: 1, cards: 1, decks: 1 });
            if (!user) return;

            if (flag && Array.isArray(user.rewards) && user.rewards.includes(flag)) {
                return res.status(409).json({ success: false, status: 409, data: "", error: "Reward already claimed" });
            }

            // 3) Merge deck cards into user.cards
            const existing = Array.isArray(user.cards) ? [...user.cards] : [];
            const indexOf = (arr, tid, variant) => arr.findIndex(c => c.tid === tid && (c.variant ?? '') === (variant ?? ''));

            // quantity = number of copies of this deck to grant (usually 1)
            const grantCount = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;

            // Add cards grantCount times
            for (let k = 0; k < grantCount; k++) {
                for (const c of deckPayload.cards) {
                    if (!c || !c.tid) {
                        return res.status(400).json({ success: false, status: 400, data: "", error: "Invalid card inside deck payload (missing 'tid')" });
                    }
                    const variant = c.variant ?? '';
                    const addQty = Math.max(1, Number(c.quantity ?? 1));
                    const i = indexOf(existing, c.tid, variant);
                    if (i >= 0) existing[i].quantity = (existing[i].quantity || 0) + addQty;
                    else existing.push({ tid: c.tid, variant, quantity: addQty });
                }

                // If you want to also grant the hero card itself as a collectible, uncomment:
                // if (deckPayload.hero && deckPayload.hero.tid) {
                //     const hv = deckPayload.hero.variant ?? '';
                //     const hi = indexOf(existing, deckPayload.hero.tid, hv);
                //     if (hi >= 0) existing[hi].quantity = (existing[hi].quantity || 0) + 1;
                //     else existing.push({ tid: deckPayload.hero.tid, variant: hv, quantity: 1 });
                // }
            }

            // 4) Append deck(s) to user.decks
            const newDecks = Array.isArray(user.decks) ? [...user.decks] : [];
            for (let k = 0; k < grantCount; k++) {
                newDecks.push(deckPayload);
            }

            // 5) Persist (cards + decks) and add flag once
            const updateDoc = { $set: { cards: existing, decks: newDecks } };
            if (flag) updateDoc.$addToSet = { rewards: flag };

            const updatedUser = await users.findOneAndUpdate(
                { id: userID },
                updateDoc,
                { returnDocument: 'after' }
            );

            return res.json({ success: true, status: 200, data: updatedUser, error: "" });
        }

        // ----- Unknown type -----
        return res.status(400).json({ success: false, status: 400, data: "", error: `Invalid reward type '${type}'` });

    } catch (err) {
        console.error("[/users/rewards/gain] Error:", err);
        return res.status(500).json({ success: false, status: 500, data: "", error: "Database error" });
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

// POST /users/packs/buy/:userID
app.post('/users/packs/buy/:userID', async (req, res) => {
    try {
        const userID = req.params.userID;
        let { pack, variant, quantity, totalCost } = req.body;

        // minimal validation
        if (!pack || typeof pack !== 'string') {
            return res.status(400).json({ success: false, status: 400, data: "", error: "Missing or invalid 'pack'" });
        }
        variant = (typeof variant === 'string') ? variant : "";
        quantity = parseInt(quantity, 10);
        if (isNaN(quantity) || quantity <= 0) quantity = 1;
        totalCost = Number(totalCost) || 0; // trusted from client

        const user = await users.findOne({ id: userID });
        if (!user) {
            return res.status(404).json({ success: false, status: 404, data: "", error: "No User Found" });
        }

        // adjust coins (no server-side price check)
        const newCoins = (Number(user.coins) || 0) - totalCost;

        // merge pack into user.packs as { tid, variant, quantity }
        const packs = Array.isArray(user.packs) ? [...user.packs] : [];
        const idx = packs.findIndex(p => p.tid === pack && ((p.variant ?? "") === variant));
        if (idx >= 0) packs[idx].quantity = (packs[idx].quantity || 0) + quantity;
        else packs.push({ tid: pack, variant, quantity });

        const updatedUser = await users.findOneAndUpdate(
            { id: userID },
            { $set: { coins: newCoins, packs } },
            { new: true }
        );

        return res.json({ success: true, status: 200, data: updatedUser, error: "" });
    } catch (err) {
        console.error("Buy pack error:", err);
        return res.status(500).json({ success: false, status: 500, data: "", error: "Database Error" });
    }
});

app.post('/users/packs/open/:userID', async (req, res) => {
    try {
        const userID = req.params.userID;
        const { pack } = req.body;

        if (!pack || typeof pack !== 'string') {
            return res.status(400).json({
                success: false,
                status: 400,
                data: "",
                error: "Invalid request: 'pack' is required"
            });
        }

        // --- load user ---
        const user = await users.findOne({ id: userID });
        if (!user) {
            return res.status(404).json({
                success: false,
                status: 404,
                data: "",
                error: "No User Found"
            });
        }

        console.log("User:", user.username);

        // --- find pack ---
        let packs = Array.isArray(user.packs) ? [...user.packs] : [];
        const idx = packs.findIndex(p => p.tid === pack);

        if (idx < 0) {
            return res.status(400).json({
                success: false,
                status: 400,
                data: "",
                error: "Pack not found in inventory"
            });
        }

        if ((packs[idx].quantity || 0) <= 0) {
            return res.status(400).json({
                success: false,
                status: 400,
                data: "",
                error: "No packs left to open"
            });
        }

        // --- reduce by 1 ---
        packs[idx].quantity -= 1;

        // --- update DB ---
        await users.updateOne(
            { id: userID },
            { $set: { packs } }
        );

        return res.json({
            success: true,
            status: 200,
            data: { pack, remaining: packs[idx].quantity },
            error: ""
        });

    } catch (err) {
        console.error("Open Pack Error:", err);
        return res.status(500).json({
            success: false,
            status: 500,
            data: "",
            error: "Database Error"
        });
    }
});

app.post('/users/pay/', async (request, response) => {
    try {
        let { userID, quantity, productID } = request.body; // card = tid
        console.log("Processing payment for " + userID + " of product " + productID + " x" + quantity);
        await fetch("https://api.staging.startlands.com/api/product/purchase", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({

                "user_id": userID,
                "product_id": productID,
                "quantity": quantity
            })
        })
        response.status(200).json({ success: true, status: 200, data: "", error: "" });
    } catch (error) {
        console.log(error.message);
        return response.status(500).json({ success: false, status: 500, data: "", error: "Database Error" });
    }
});

app.get('/product/price/', async (request, response) => {

    try {
        let { productID } = request.query; 

        console.log(productID);

        // Get product ID cost
        const targetProduct = await product.findOne({ productID: productID });

        console.log("Found: " + targetProduct.productID + " - Price: " + targetProduct.product_cost);

        response.status(200).json({

            success: true,
            status: 200,
            data: targetProduct,
            error: ""

        });

    } catch (error) {
        console.log(error.message);
        return response.status(500).json({ success: false, status: 500, data: "", error: "Database Error" });
    }
});  


// Start Express + WebSocket on the same server
const server = app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});

const { startWebSocket } = require('./ws-server');
startWebSocket(server, { path: '/ws' });


// Example endpoint to trigger notification (for Bruno testing)
// Payment success route (Dragonpay webhook etc.)
app.post('/users/pay/success/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { tokenType, quantity } = req.body;

        const qty = Number(quantity);
        if (isNaN(qty)) {
            return res.status(400).json({ error: 'Quantity must be a number' });
        }

        //  Use the "id" field, not the Mongo _id
        const result = await users.updateOne(
            { id: userId },
            { $inc: { [tokenType]: qty } }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: 'User not found or no update applied' });
        }

        notifyPaymentSuccess(userId);

        res.json({ success: true, updated: result.modifiedCount });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Payment update failed' });
    }
});

app.post('/users/pay/process/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: "Missing 'url' in request body" });
        }

        console.log(`[PayProcessAPI] userId=${userId}, url=${url}`);

        // Pass url to WebSocket notify
        const notified = notifyPaymentProcess(userId, url);

        res.json({ success: true, notified });
    } catch (err) {
        console.error("[PayProcessAPI] Error:", err);
        res.status(500).json({ error: 'Payment process failed' });
    }
});

app.post('/users/game/activeroom/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { roomName } = req.body;

        if (!roomName || typeof roomName !== 'string') {
            return res.status(400).json({ success: false, error: "Missing or invalid 'roomName' in request body" });
        }

        // Use the 'id' field instead of '_id' or 'username'
        const filter = { id: userId };

        const result = await users.updateOne(filter, {
            $set: { activeRoomName: roomName.trim() }
        });

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        res.json({
            success: true,
            status: 200,
            data: { userId, activeRoomName: roomName.trim(), modified: result.modifiedCount },
            error: ""
        });

    } catch (err) {
        console.error("[ActiveRoomAPI] Error:", err);
        res.status(500).json({ success: false, error: 'Failed to update active room' });
    }
});


// ============================================
// GET /leaderboard/top?limit=100
// Sort priority: ELO (desc), Winrate (desc), Matches (asc)
// ============================================
app.get('/leaderboard/top', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
        console.log(`[LeaderboardAPI] Fetching top ${limit} players (permission_level=1)`);

        const pipeline = [
            { $match: { permission_level: 1 } },

            {
                $project: {
                    _id: 0,
                    username: 1,
                    elo: { $ifNull: ["$elo", 0] },
                    victories: { $ifNull: ["$victories", 0] },
                    defeats: { $ifNull: ["$defeats", 0] },
                    permission_level: 1,

                    // Calculate matches
                    matches: {
                        $add: [
                            { $ifNull: ["$victories", 0] },
                            { $ifNull: ["$defeats", 0] }
                        ]
                    },

                    // Calculate winrate
                    winrate: {
                        $cond: [
                            { $gt: [{ $add: [{ $ifNull: ["$victories", 0] }, { $ifNull: ["$defeats", 0] }] }, 0] },
                            {
                                $round: [
                                    {
                                        $multiply: [
                                            {
                                                $divide: [
                                                    { $ifNull: ["$victories", 0] },
                                                    {
                                                        $add: [
                                                            { $ifNull: ["$victories", 0] },
                                                            { $ifNull: ["$defeats", 0] }
                                                        ]
                                                    }
                                                ]
                                            },
                                            100
                                        ]
                                    },
                                    0
                                ]
                            },
                            0
                        ]
                    }
                }
            },

            // Sort by ELO ↓, Winrate ↓, Matches ↑
            { $sort: { elo: -1, winrate: -1, matches: 1 } },

            { $limit: limit }
        ];

        const entries = await users.aggregate(pipeline).toArray();
        console.log(`[LeaderboardAPI] Found ${entries.length} entries`);

        res.json(entries);
    } catch (err) {
        console.error("[LeaderboardAPI] Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// ============================================
// POST /matches/complete
// ============================================
// Body: { unameWinner: "username_winner", unameLoser: "username_loser" }
// Winner: +10 ELO, +1 match, +1 victory
// Loser : -10 ELO, +1 match, +1 defeat
// Clears activeRoomName for both
// ============================================
app.post('/matches/complete', async (req, res) => {
    try {
        const { unameWinner, unameLoser } = req.body;

        if (!unameWinner || !unameLoser) {
            return res.status(400).json({
                success: false,
                error: "Missing 'unameWinner' or 'unameLoser' in request body"
            });
        }

        console.log(`[MatchCompleteAPI] Incoming:`, req.body);

        // Find players by username
        const winner = await users.findOne({ username: unameWinner });
        const loser = await users.findOne({ username: unameLoser });

        if (!winner || !loser) {
            return res.status(404).json({
                success: false,
                error: `Winner or loser not found (${unameWinner}, ${unameLoser})`
            });
        }

        const ELO_GAIN = 10;
        const ELO_LOSS = -10;

        // Update winner
        await users.updateOne(
            { username: unameWinner },
            {
                $inc: { elo: ELO_GAIN, matches: 1, victories: 1 },
                $set: { last_match_at: new Date(), activeRoomName: "" }
            }
        );

        // Update loser
        await users.updateOne(
            { username: unameLoser },
            {
                $inc: { elo: ELO_LOSS, matches: 1, defeats: 1 },
                $set: { last_match_at: new Date(), activeRoomName: "" }
            }
        );

        // Insert match record (optional)
        const matchRecord = {
            unameWinner,
            unameLoser,
            eloChangeWinner: ELO_GAIN,
            eloChangeLoser: ELO_LOSS,
            createdAt: new Date()
        };
        await database.collection('matches').insertOne(matchRecord);

        console.log(
            `[MatchCompleteAPI] Winner ${unameWinner} +${ELO_GAIN} | Loser ${unameLoser} ${ELO_LOSS} | Room cleared`
        );

        return res.json({
            success: true,
            status: 200,
            data: {
                unameWinner,
                unameLoser,
                eloGain: ELO_GAIN,
                eloLoss: ELO_LOSS,
                roomCleared: true
            },
            error: ""
        });

    } catch (err) {
        console.error("[MatchCompleteAPI] Error:", err);
        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});

// ============================================
// GET /users/achievements/init/:userId
// ============================================
// Initializes daily achievements if missing,
// resets dayWins if new date, returns server date (YYYY-MM-DD)
// ============================================
app.get('/users/achievements/init/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;

        // === 1. Compute Philippine local date (UTC+8) ===
        const offsetHours = 8; // Philippines timezone
        const now = new Date();
        const phNow = new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
        const todayPH = phNow.toISOString().split('T')[0]; // "YYYY-MM-DD"

        // === 2. Fetch user ===
        const user = await users.findOne({ id: userId });
        if (!user) {
            return res.status(404).json({
                success: false,
                error: "User not found"
            });
        }

        // === 3. Default achievement structure with embedded trackers ===
        const defaultAchievements = {
            first_win: { isCompleted: false, dateCompleted: null },
            ten_wins: { isCompleted: false, dateCompleted: null },
            trackers: {
                dayWins: 0,
                lastInitDate: todayPH
            }
        };

        const updateFields = {};

        // === 4. Initialize missing fields ===
        if (!user.achievements) {
            updateFields.achievements = defaultAchievements;
        }

        const userAchievements = user.achievements || {};
        const trackers = userAchievements.trackers || { dayWins: 0, lastInitDate: todayPH };

        // === 5. Compare PH dates ===
        const lastInitDateStr = trackers.lastInitDate || todayPH;
        const lastInitDate = new Date(lastInitDateStr + "T00:00:00+08:00");
        const todayDate = new Date(todayPH + "T00:00:00+08:00");

        if (todayDate > lastInitDate) {
            // ✅ Reset achievements for new PH day
            updateFields.achievements = {
                first_win: { isCompleted: false, dateCompleted: null },
                ten_wins: { isCompleted: false, dateCompleted: null },
                trackers: {
                    dayWins: 0,
                    lastInitDate: todayPH
                }
            };
            console.log(`[AchievementsInit] [PH Time] New day detected (${todayPH}) — reset achievements for ${userId}`);
        } else {
            console.log(`[AchievementsInit] [PH Time] Same day (${todayPH}) — no reset needed.`);
        }

        // === 6. Apply any missing or reset fields ===
        if (Object.keys(updateFields).length > 0) {
            await users.updateOne({ id: userId }, { $set: updateFields });
        }

        // === 7. Reload updated user ===
        const updatedUser = await users.findOne({ id: userId });

        // === 8. Convert achievements to array for Unity ===
        const achievementsArray = Object.entries(updatedUser.achievements)
            .filter(([key]) => key !== "trackers")
            .map(([id, value]) => ({
                id,
                isCompleted: value.isCompleted,
                dateCompleted: value.dateCompleted
            }));

        // === 9. Return formatted response ===
        res.json({
            success: true,
            status: 200,
            data: {
                serverTimeUTC: todayPH, // returns PH date for Unity display
                achievements: {
                    list: achievementsArray,
                    trackers: updatedUser.achievements.trackers
                }
            },
            error: ""
        });

    } catch (err) {
        console.error("[AchievementsInitAPI] Error:", err);
        res.status(500).json({
            success: false,
            status: 500,
            data: "",
            error: "Database error"
        });
    }
});















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


