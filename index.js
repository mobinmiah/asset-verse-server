require('dotenv').config();
const express = require('express')
const cors = require('cors')
const app = express()
// const crypto = require("crypto");
const port = process.env.PORT || 3000
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const stripe = require('stripe')(process.env.STRIPE_KEY);

// const serviceAccount = require("./asset-verse-firebase-admin-sdk.json");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


// middle wares
app.use(cors())
app.use(express.json())

const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access" });
    }

    const token = authHeader.split(" ")[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).send({ message: "Forbidden access" });
        }
        req.decoded = decoded;
        next();
    });
};



const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.9hcy35q.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});



async function run() {
    try {
        // await client.connect();

        const db = client.db("assetVerseDB")
        const packagesCollection = db.collection("packages")
        const usersCollection = db.collection("users")
        const assetsCollection = db.collection("assets")
        const requestCollection = db.collection('requests')

        async function syncCurrentEmployees(hrEmail) {
            const count = await usersCollection.countDocuments({
                role: "employee",
                "affiliations.hrEmail": hrEmail
            });

            await usersCollection.updateOne(
                { email: hrEmail },
                { $set: { currentEmployees: count } }
            );
        }

        // verify hr middleware with database access
        const verifyHR = async (req, res, next) => {
            const email = req.decoded.email
            const query = { email }
            const user = await usersCollection.findOne(query)

            if (!user || user.role !== 'hr') {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            next()
        }

        // verify employee middleware with database access
        const verifyEmployee = async (req, res, next) => {
            const email = req.decoded.email
            const query = { email }
            const user = await usersCollection.findOne(query)

            if (!user || user.role !== 'employee') {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            next()
        }

        // jwt api
        app.post("/jwt", async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
                expiresIn: "7d",
            });
            res.send({ token });
        });


        // global apis
        app.get('/', (req, res) => {
            res.send('Asset Verse Server is Running')
        })

        // packages api
        app.get('/packages', async (req, res) => {
            const cursor = packagesCollection.find()
            const result = await cursor.toArray()
            res.send(result)
        })

        app.get('/packages/hr', verifyToken, verifyHR, async (req, res) => {
            const cursor = packagesCollection.find()
            const result = await cursor.toArray()
            res.send(result)
        })

        // payment apis
        app.post("/checkout-session", verifyToken, verifyHR, async (req, res) => {
            try {
                const email = req.decoded.email
                const packageInfo = req.body;
                const amount = parseInt(packageInfo.price) * 100;
                const session = await stripe.checkout.sessions.create({
                    line_items: [
                        {
                            price_data: {
                                currency: "USD",
                                unit_amount: amount,
                                product_data: {
                                    name: packageInfo.name,
                                },
                            },
                            quantity: 1,
                        },
                    ],
                    customer_email: req.decoded.email,
                    mode: "payment",
                    metadata: {
                        email: email,
                        packageName: packageInfo.name,
                        employeeLimit: packageInfo.employeeLimit,
                    },
                    success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
                });

                res.send({ url: session.url });

            } catch (error) {

                res.status(500).send({ message: "Failed to create checkout session" });
            }
        });


        app.patch("/payment-success", verifyToken, verifyHR, async (req, res) => {
            try {
                const sessionId = req.body.sessionId;
                const session = await stripe.checkout.sessions.retrieve(sessionId);

                if (session.payment_status !== "paid") {
                    return res.status(400).send({ success: false, message: "Payment not completed" });
                }

                const email = session.metadata.email;
                const planName = session.metadata.packageName;
                const employeeLimit = Number(session.metadata.employeeLimit);

                await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            subscription: planName,
                            packageLimit: employeeLimit,
                            paid: true,
                            upgradedAt: new Date(),
                        },
                    }
                );

                res.send({ success: true, message: `Plan upgraded to ${planName}` });

            } catch (error) {
                console.error(error);
                res.status(500).send({ success: false, message: "Something went wrong" });
            }
        });

        // users apis
        app.post("/users", async (req, res) => {
            const newUser = req.body;
            const existingUser = await usersCollection.findOne({ email: newUser.email });
            if (existingUser) {
                return res.send({ message: "User already exists. No need to add again." });
            }
            const result = await usersCollection.insertOne(newUser);
            res.send(result);
        });

        app.get("/users", verifyToken, verifyHR, async (req, res) => {
            const result = await usersCollection.find().toArray();
            console.log(result)
            res.send(result);
        });

        app.get('/users/employee', verifyToken, verifyHR, async (req, res) => {
            try {
                const hrEmail = req.decoded.email;

                const employees = await usersCollection.find({
                    role: "employee",
                    "affiliations.hrEmail": hrEmail
                }).toArray();

                const result = employees.map(emp => ({
                    _id: emp._id,
                    name: emp.name,
                    email: emp.email,
                    photoURL: emp.photoURL || emp.photo,
                    createdAt: emp.createdAt,
                    assetCount: emp.assets?.length || 0
                }));

                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server Error" });
            }
        });

        app.delete('/users/employees/:id', verifyToken, verifyHR, async (req, res) => {
            try {
                const hrEmail = req.decoded.email;
                const employeeId = new ObjectId(req.params.id);
                const employee = await usersCollection.findOne({ _id: employeeId, role: "employee" });
                const assets = employee.assets || [];

                for (const item of assets) {
                    await assetsCollection.updateOne(
                        { _id: item.assetId },
                        { $inc: { productQuantity: 1 } }
                    );
                }

                await usersCollection.updateOne(
                    { _id: employeeId },
                    { $set: { assets: [] } }
                );

                await usersCollection.updateOne(
                    { _id: employeeId },
                    { $pull: { affiliations: { hrEmail } } }
                );

                await usersCollection.updateOne(
                    { email: hrEmail },
                    { $inc: { currentEmployees: -1 } }
                );

                res.send({ success: true });

            } catch (error) {
                console.error("Remove employee error:", error);
                res.status(500).send({ message: "Server error" });
            }
        });


        app.get('/users/:email', verifyToken, async (req, res) => {
            const email = req.params.email
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            const result = await usersCollection.findOne({ email })
            res.send(result)
        })

        app.get('/users/:email/role', verifyToken, async (req, res) => {
            const email = req.params.email
            const query = { email }
            const user = await usersCollection.findOne(query)
            res.send({ role: user?.role || 'employee' })
        })

        app.patch("/users/:email", verifyToken, async (req, res) => {
            const email = req.params.email;
            const decodedEmail = req.decoded.email

            if (email !== decodedEmail) {
                return res.status(403).send({ message: "Forbidden access" });
            }

            const updatedData = req.body;
            delete updatedData.role;
            delete updatedData.email;
            const result = await usersCollection.updateOne(
                { email },
                { $set: updatedData }
            );
            res.send(result);
        });


        // assets apis
        app.post('/assets', verifyToken, verifyHR, async (req, res) => {
            const asset = req.body
            asset.createdAt = new Date()
            const result = await assetsCollection.insertOne(asset)
            res.send(result)
        })

        app.get("/assets", verifyToken, verifyHR, async (req, res) => {
            try {
                const searchText = req.query.searchText || "";
                const email = req.decoded.email;

                const query = {
                    hrEmail: email,
                };

                if (searchText) {
                    query.$or = [
                        { productName: { $regex: searchText, $options: "i" } },
                        { productType: { $regex: searchText, $options: "i" } },
                    ];
                }

                const result = await assetsCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to fetch assets" });
            }
        });

        app.get("/assets/public", verifyToken, async (req, res) => {
            const searchText = req.query.searchText || "";
            const limit = parseInt(req.query.limit);
            const skip = parseInt(req.query.skip);

            const query = searchText
                ? { productName: { $regex: searchText, $options: "i" } }
                : {};

            const assets = await assetsCollection
                .find(query)
                .skip(skip)
                .sort({ createdAt: -1 })
                .limit(limit)
                .toArray();

            const total = await assetsCollection.countDocuments(query);

            res.send({
                assets,
                total,
            });
        });

        app.get("/analytics/asset-types", verifyToken, verifyHR, async (req, res) => {
            const hrEmail = req.decoded.email;
            const assets = await assetsCollection.find({ hrEmail }).project({ productType: 1 }).toArray();
            let returnable = 0;
            let nonReturnable = 0;

            assets.forEach(asset => {
                if (asset.productType === "Returnable") {
                    returnable++;
                } else if (asset.productType === "Non-returnable") {
                    nonReturnable++;
                }
            });

            res.send([
                { name: "Returnable", value: returnable },
                { name: "Non-returnable", value: nonReturnable },
            ]);
        });

        app.get("/analytics/top-requested-assets", verifyToken, verifyHR, async (req, res) => {
            const hrEmail = req.decoded.email;
            const requests = await requestCollection.find({ hrEmail }).project({ productName: 1 }).toArray();
            const requestCountMap = {};

            requests.forEach(reqItem => {
                const name = reqItem.productName;
                requestCountMap[name] = (requestCountMap[name] || 0) + 1;
            });

            const result = Object.entries(requestCountMap)
                .map(([name, requests]) => ({ name, requests }))
                .sort((a, b) => b.requests - a.requests)
                .slice(0, 5);

            res.send(result);
        }
        );

        app.patch('/assets/:id', verifyToken, verifyHR, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const { productName, productImage, productType, productQuantity } = req.body;
            const asset = await assetsCollection.findOne(query);

            if (!asset) {
                return res.status(404).send({ message: "Asset not found" });
            }

            if (asset.hrEmail !== req.decoded.email) {
                return res.status(403).send({
                    message: "Forbidden access"
                });
            }

            const updateDoc = {
                $set: {
                    productName: productName || asset.productName,
                    productImage: productImage || asset.productImage,
                    productType: productType || asset.productType,
                    productQuantity: productQuantity || asset.productQuantity,
                }
            };
            const result = await assetsCollection.updateOne(query, updateDoc);
            res.send(result);
        });

        app.patch('/assets/:id/employee', verifyToken, verifyHR, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const { productName, productImage, productType, productQuantity } = req.body;
            const asset = await assetsCollection.findOne(query);

            if (!asset) {
                return res.status(404).send({ message: "Asset not found" });
            }

            if (asset.hrEmail !== req.decoded.email) {
                return res.status(403).send({
                    message: "Forbidden access"
                });
            }

            const updateDoc = {
                $set: {
                    productName: productName || asset.productName,
                    productImage: productImage || asset.productImage,
                    productType: productType || asset.productType,
                    productQuantity: productQuantity || asset.productQuantity,
                }
            };
            const result = await assetsCollection.updateOne(query, updateDoc);
            res.send(result);
        });

        app.delete('/assets/:id', verifyToken, verifyHR, async (req, res) => {
            const id = req.params.id;
            const email = req.decoded.email;
            const query = {
                _id: new ObjectId(id),
                hrEmail: email,
            };

            if (!email) {
                return res.status(403).send({ message: "Forbidden access" });
            }
            const result = await assetsCollection.deleteOne(query)
            res.send(result)
        })

        // request apis
        app.post("/asset-requests", verifyToken, verifyEmployee, async (req, res) => {
            const { assetId } = req.body;
            const employeeEmail = req.decoded.email;
            const asset = await assetsCollection.findOne({
                _id: new ObjectId(assetId),
            });
            if (!asset) {
                return res.status(404).send({ message: "Asset not found" });
            }
            if (asset.productQuantity === 0) {
                return res.status(400).send({
                    message: "Asset is currently unavailable",
                });
            }
            const employee = await usersCollection.findOne({
                email: employeeEmail,
            });
            const request = {
                assetId: asset._id,
                productName: asset.productName,
                productImage: asset.productImage,
                productType: asset.productType,
                employeeEmail,
                employeeName: employee?.name || "Unknown",
                hrEmail: asset.hrEmail,
                companyName: asset.companyName,

                status: "pending",
                requestDate: new Date(),
            };

            const existingRequest = await requestCollection.findOne({
                assetId: asset._id,
                employeeEmail,
                status: "pending",
            });

            if (existingRequest) {
                return res.status(400).send({
                    message: "You already requested this asset",
                });
            }


            await requestCollection.insertOne(request);

            res.send({ success: true });
        });


        app.get("/asset-requests/hr", verifyToken, verifyHR, async (req, res) => {
            const hrEmail = req.decoded.email;

            const requests = await requestCollection
                .find({ hrEmail })
                .sort({ requestDate: -1 })

                .toArray();

            res.send(requests);
        });

        app.patch("/requests/:id/status", verifyToken, verifyHR, async (req, res) => {
            const { status } = req.body;
            const id = req.params.id;
            const requestQuery = { _id: new ObjectId(id) };
            const request = await requestCollection.findOne(requestQuery);

            if (request.status !== "pending") {
                return res.status(400).send({ message: "Already processed" });
            }

            if (status === "rejected") {
                const updatedRejection = {
                    $set: {
                        status: "rejected",
                        actionDate: new Date(),
                    },
                }
                await requestCollection.updateOne(requestQuery, updatedRejection);
                return res.send({ success: true });
            }

            const assetQuery = { _id: request.assetId };
            const asset = await assetsCollection.findOne(assetQuery);

            if (asset.productQuantity <= 0) {
                return res.status(400).send({ message: "Asset is Empty" });
            }

            const deductQuantity = {
                $inc: { productQuantity: -1 },
            }
            await assetsCollection.updateOne(assetQuery, deductQuantity);

            const employeeEmail = { email: request.employeeEmail }
            const pushAsset = {
                $push: {
                    assets: {
                        assetId: asset._id,
                        productName: asset.productName,
                        productImage: asset.productImage,
                        productType: asset.productType,
                        companyName: asset.companyName,
                        hrEmail: asset.hrEmail,
                        assignedDate: new Date(),
                    },
                },
            }
            await usersCollection.updateOne(employeeEmail, pushAsset);

            const hrEmailQuery = {
                email: request.employeeEmail,
                "affiliations.hrEmail": { $ne: request.hrEmail },
            }
            const pushAffiliation = {
                $push: {
                    affiliations: {
                        hrEmail: request.hrEmail,
                        companyName: request.companyName,
                        joinedAt: new Date(),
                    },
                },
            }
            await usersCollection.updateOne(hrEmailQuery, pushAffiliation);

            const hrEmail = req.decoded.email;
            await usersCollection.updateOne(
                { email: hrEmail },
                { $inc: { currentEmployees: 1 } }
            );

            const updateRequestStatus = {
                $set: {
                    status: "approved",
                    actionDate: new Date(),
                },
            };
            await requestCollection.updateOne(requestQuery, updateRequestStatus);

            res.send({ success: true });

        }
        );

        app.get("/asset-requests/employee", verifyToken, verifyEmployee, async (req, res) => {
            try {
                const employeeEmail = req.decoded.email;
                const requests = await requestCollection
                    .find({ employeeEmail, status: "approved" })
                    .sort({ requestDate: -1 })
                    .toArray();
                res.send(requests);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        // Delete an asset request (HR only)
        app.delete("/requests/:id", verifyToken, verifyHR, async (req, res) => {
            try {
                const { id } = req.params;
                const hrEmail = req.decoded.email;

                // Find the request
                const request = await requestCollection.findOne({ _id: new ObjectId(id), hrEmail });
                if (!request) {
                    return res.status(404).send({ message: "Request not found" });
                }

                // Optional: if already approved, return the asset quantity
                if (request.status === "approved") {
                    await assetsCollection.updateOne(
                        { _id: request.assetId },
                        { $inc: { productQuantity: 1 } }
                    );

                    // Remove asset from employee
                    await usersCollection.updateOne(
                        { email: request.employeeEmail },
                        { $pull: { assets: { assetId: request.assetId } } }
                    );

                    // Decrement HR currentEmployees
                    await usersCollection.updateOne(
                        { email: hrEmail },
                        { $inc: { currentEmployees: -1 } }
                    );
                }

                // Delete the request
                await requestCollection.deleteOne({ _id: new ObjectId(id), hrEmail });

                res.send({ success: true, message: "Request deleted successfully" });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });











        // await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {

    }
}
run().catch(console.dir);


app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
