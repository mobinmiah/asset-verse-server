require('dotenv').config();
const express = require('express')
const cors = require('cors')
const app = express()
const port = process.env.PORT || 3000
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const stripe = require('stripe')(process.env.STRIPE_KEY);

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


// middle wares
app.use(cors())
app.use(express.json())

const verifyToken = (req, res, next) => {
    console.log("verifyToken middleware called");
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        console.log("No authorization header found");
        return res.status(401).send({ message: "Unauthorized access" });
    }

    const token = authHeader.split(" ")[1];
    console.log("Token found, verifying...");
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
            console.log("Token verification failed:", err.message);
            return res.status(403).send({ message: "Forbidden access" });
        }
        console.log("Token verified for user:", decoded.email);
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
        const admin = db.collection("admin")
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
            console.log("verifyEmployee middleware called for:", req.decoded.email);
            const email = req.decoded.email
            console.log("Checking employee with email:", email);
            const query = { email }
            const user = await usersCollection.findOne(query)
            console.log("Found user:", user ? `${user.name} (role: "${user.role}")` : "No user found");

            if (!user) {
                console.log("Access denied - no user found");
                return res.status(403).send({ message: 'User not found' })
            }

            if (user.role !== 'employee') {
                console.log("Access denied - user role:", `"${user.role}"`, "expected: 'employee'");
                return res.status(403).send({ message: `Access denied. User role is "${user.role}", expected "employee"` })
            }

            console.log("Employee verification successful for:", user.name);
            next()
        }

        // verify admin middleware with database access
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email
            const query = { email }
            const adminUser = await admin.findOne(query)

            if (!adminUser || adminUser.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            next()
        }

        // jwt api
        app.post("/jwt", async (req, res) => {
            console.log("JWT endpoint called with:", req.body);
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
                expiresIn: "7d",
            });
            console.log("Token generated for user:", user.email);
            res.send({ token });
        });


        // global api
        app.get('/', (req, res) => {
            res.send(' Verse Server is Running')
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


        // Get admin profile
        app.get("/admin/:email", verifyToken, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'Forbidden access' });
            }
            const query = { email };
            const result = await admin.findOne(query);
            res.send(result);
        });

        app.get("/users-for-admin", verifyToken, verifyAdmin, async (req, res) => {
            try {
                const users = await usersCollection.find().toArray();

                // Add asset count for HR users
                const enrichedUsers = await Promise.all(users.map(async (user) => {
                    if (user.role === 'hr') {
                        // Count assets belonging to this HR
                        const assetCount = await assetsCollection.countDocuments({ hrEmail: user.email });
                        return { ...user, totalAssets: assetCount };
                    }
                    return user;
                }));

                console.log('Users with asset counts:', enrichedUsers);
                res.send(enrichedUsers);
            } catch (error) {
                console.error('Error fetching users for admin:', error);
                res.status(500).send({ message: 'Server error' });
            }
        });

        // Organizations for admin - Get all organizations (HR users) with asset counts
        app.get("/organizations-for-admin", verifyToken, verifyAdmin, async (req, res) => {
            try {
                const organizations = await usersCollection
                    .find({ role: "hr" })
                    .project({
                        name: 1,
                        email: 1,
                        companyName: 1,
                        companyLogo: 1,
                        subscription: 1,
                        packageLimit: 1,
                        currentEmployees: 1,
                        paid: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        phone: 1,
                        address: 1
                    })
                    .sort({ createdAt: -1 })
                    .toArray();

                // Get asset counts and employee counts for each organization
                const orgsWithCounts = await Promise.all(
                    organizations.map(async (org) => {
                        // Count assets belonging to this HR
                        const assetCount = await assetsCollection.countDocuments({ hrEmail: org.email });

                        // Count employees belonging to this HR (using affiliations)
                        const employeeCount = await usersCollection.countDocuments({
                            role: "employee",
                            "affiliations.hrEmail": org.email
                        });

                        // Sync the currentEmployees field to ensure accuracy
                        if (employeeCount !== org.currentEmployees) {
                            await usersCollection.updateOne(
                                { email: org.email },
                                { $set: { currentEmployees: employeeCount } }
                            );
                        }

                        return {
                            ...org,
                            assetCount,
                            actualEmployees: employeeCount,
                            currentEmployees: employeeCount // Update with real count
                        };
                    })
                );

                console.log('Organizations with counts:', orgsWithCounts);
                res.send(orgsWithCounts);
            } catch (error) {
                console.error('Error fetching organizations for admin:', error);
                res.status(500).send({ message: 'Server error' });
            }
        });

        app.get("/users", verifyToken, async (req, res) => {
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

        // Check if user is admin from admin collection (no auth required for role checking)
        app.get('/admin/check/:email', async (req, res) => {
            try {
                const email = req.params.email;
                const query = { email };
                const adminUser = await admin.findOne(query);

                if (adminUser) {
                    res.send({
                        isAdmin: true,
                        role: 'admin',
                        adminData: adminUser
                    });
                } else {
                    res.send({
                        isAdmin: false,
                        role: null
                    });
                }
            } catch (error) {
                console.error('Error checking admin:', error);
                res.status(500).send({ message: 'Server error' });
            }
        });

        app.get('/users/:email/role', verifyToken, async (req, res) => {
            const email = req.params.email
            const query = { email }

            // First check if user is admin
            const adminUser = await admin.findOne(query);
            if (adminUser) {
                return res.send({ role: 'admin' });
            }

            // Then check regular users
            const user = await usersCollection.findOne(query)
            res.send({ role: user?.role || 'employee' })
        })
        app.get('/users/:email', verifyToken, async (req, res) => {
            const email = req.params.email
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            const result = await usersCollection.findOne({ email })
            res.send(result)
        })

        app.patch("/users/:email", verifyToken, async (req, res) => {
            try {
                const email = req.params.email;
                const decodedEmail = req.decoded.email;

                if (email !== decodedEmail) {
                    return res.status(403).send({ message: "Forbidden access" });
                }

                const updatedData = req.body;
                // Prevent updating sensitive fields
                delete updatedData.role;
                delete updatedData.email;
                delete updatedData._id;

                // Add updated timestamp
                updatedData.updatedAt = new Date();

                // Check if user is admin first
                const adminUser = await admin.findOne({ email });
                if (adminUser) {
                    // Update admin collection
                    const result = await admin.updateOne(
                        { email },
                        { $set: updatedData }
                    );

                    if (result.matchedCount === 0) {
                        return res.status(404).send({ message: "Admin not found" });
                    }

                    return res.send({ success: true, message: "Admin profile updated successfully" });
                }

                // Get current user data to check if it's HR and if company name changed
                const currentUser = await usersCollection.findOne({ email });
                if (!currentUser) {
                    return res.status(404).send({ message: "User not found" });
                }

                // Update regular user
                const result = await usersCollection.updateOne(
                    { email },
                    { $set: updatedData }
                );

                // If this is an HR user, update all related records with any changed HR information
                if (currentUser.role === 'hr') {
                    console.log(`HR ${email} updated profile. Cascading changes to all related records...`);

                    // Prepare update object for assets and requests
                    const assetUpdates = {};
                    const affiliationUpdates = {};

                    // Check for changes in asset-related fields
                    if (updatedData.companyName && updatedData.companyName !== currentUser.companyName) {
                        assetUpdates.companyName = updatedData.companyName;
                        affiliationUpdates["affiliations.$.companyName"] = updatedData.companyName;
                        console.log(`- Company name changed: "${currentUser.companyName}" → "${updatedData.companyName}"`);
                    }

                    if (updatedData.companyLogo && updatedData.companyLogo !== currentUser.companyLogo) {
                        assetUpdates.companyLogo = updatedData.companyLogo;
                        affiliationUpdates["affiliations.$.companyLogo"] = updatedData.companyLogo;
                        console.log(`- Company logo changed`);
                    }

                    if (updatedData.name && updatedData.name !== currentUser.name) {
                        assetUpdates.hrName = updatedData.name;
                        affiliationUpdates["affiliations.$.hrName"] = updatedData.name;
                        console.log(`- HR name changed: "${currentUser.name}" → "${updatedData.name}"`);
                    }

                    if (updatedData.phone && updatedData.phone !== currentUser.phone) {
                        assetUpdates.hrPhone = updatedData.phone;
                        affiliationUpdates["affiliations.$.hrPhone"] = updatedData.phone;
                        console.log(`- HR phone changed`);
                    }

                    if (updatedData.address && updatedData.address !== currentUser.address) {
                        assetUpdates.companyAddress = updatedData.address;
                        affiliationUpdates["affiliations.$.companyAddress"] = updatedData.address;
                        console.log(`- Company address changed`);
                    }

                    if (updatedData.department && updatedData.department !== currentUser.department) {
                        assetUpdates.hrDepartment = updatedData.department;
                        affiliationUpdates["affiliations.$.hrDepartment"] = updatedData.department;
                        console.log(`- HR department changed`);
                    }

                    // Only update if there are changes
                    if (Object.keys(assetUpdates).length > 0) {
                        assetUpdates.updatedAt = new Date();

                        // Update all assets belonging to this HR
                        const assetUpdateResult = await assetsCollection.updateMany(
                            { hrEmail: email },
                            { $set: assetUpdates }
                        );
                        console.log(`- Updated ${assetUpdateResult.modifiedCount} assets`);

                        // Update all asset requests for this HR
                        const requestUpdateResult = await requestCollection.updateMany(
                            { hrEmail: email },
                            { $set: assetUpdates }
                        );
                        console.log(`- Updated ${requestUpdateResult.modifiedCount} asset requests`);

                        // Update employee affiliations
                        if (Object.keys(affiliationUpdates).length > 0) {
                            affiliationUpdates.updatedAt = new Date();
                            const affiliationUpdateResult = await usersCollection.updateMany(
                                { "affiliations.hrEmail": email },
                                { $set: affiliationUpdates }
                            );
                            console.log(`- Updated ${affiliationUpdateResult.modifiedCount} employee affiliations`);
                        }

                        console.log("✅ All related records updated successfully");
                    } else {
                        console.log("- No asset-related fields changed, skipping cascade updates");
                    }
                }

                res.send({ success: true, message: "Profile updated successfully" });
            } catch (error) {
                console.error("Profile update error:", error);
                res.status(500).send({ message: "Server error" });
            }
        });

        // my teams apis
        app.get("/companies/my", verifyToken, verifyEmployee, async (req, res) => {
            try {
                const email = req.decoded.email;

                const user = await usersCollection.findOne({ email });

                const companies = (user.affiliations || []).map(company => ({
                    hrEmail: company.hrEmail,
                    companyName: company.companyName
                }));

                res.send(companies);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        app.get("/employees/company/:hrEmail", verifyToken, verifyEmployee, async (req, res) => {
            try {
                const employeeEmail = req.decoded.email;
                const { hrEmail } = req.params;
                const employee = await usersCollection.findOne({
                    email: employeeEmail,
                    "affiliations.hrEmail": hrEmail
                });

                if (!employee) {
                    return res.status(403).send({ message: "Forbidden access" });
                }

                const team = await usersCollection.find({
                    role: "employee",
                    "affiliations.hrEmail": hrEmail
                }).project({
                    name: 1,
                    email: 1,
                    photo: 1,
                    position: 1,
                    dateOfBirth: 1
                }).toArray();

                res.send(team);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        app.post('/assets', verifyToken, verifyHR, async (req, res) => {
            const asset = req.body;

            // Generate automatic serial number if not provided
            const serialNumber = asset.serialNumber || `SN-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

            const enrichedAsset = {
                ...asset,
                serialNumber: serialNumber,
                assetCode: `AST-${Date.now()}`,
                status: "Available",
                assignedTo: null,
                assignedEmployeeName: null,
                assignedDate: null,
                expectedReturnDate: null,
                requestCount: 0,

                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const result = await assetsCollection.insertOne(enrichedAsset);
            res.send(result);
        });

        app.get("/assets", verifyToken, async (req, res) => {
            try {
                console.log('Assets endpoint accessed by:', req.decoded.email);
                const searchText = req.query.searchText || "";
                const page = parseInt(req.query.page) || 1;
                const limit = parseInt(req.query.limit) || 0;
                const status = req.query.status || "";
                const type = req.query.type || "";
                const skip = (page - 1) * limit;
                const email = req.decoded.email;

                // Check user role
                const adminUser = await admin.findOne({ email });
                console.log('Admin user check:', adminUser);
                const isAdmin = adminUser && adminUser.role === 'admin';
                console.log('Is admin:', isAdmin);

                let query = {};
                let baseQuery = {}; // For stats calculation

                if (isAdmin) {
                    // Admin sees all assets across all organizations
                    if (searchText) {
                        query.$or = [
                            { productName: { $regex: searchText, $options: "i" } },
                            { companyName: { $regex: searchText, $options: "i" } },
                            { hrEmail: { $regex: searchText, $options: "i" } },
                            { brand: { $regex: searchText, $options: "i" } },
                            { model: { $regex: searchText, $options: "i" } },
                            { category: { $regex: searchText, $options: "i" } }
                        ];
                    }
                    // Base query for admin is empty (all assets)
                    baseQuery = {};
                } else {
                    // HR sees only their own assets
                    query.hrEmail = email;
                    baseQuery.hrEmail = email;
                    if (searchText) {
                        query.$or = [
                            { productName: { $regex: searchText, $options: "i" } },
                            { productType: { $regex: searchText, $options: "i" } },
                            { brand: { $regex: searchText, $options: "i" } },
                            { model: { $regex: searchText, $options: "i" } },
                            { category: { $regex: searchText, $options: "i" } }
                        ];
                        query.hrEmail = email; // Ensure HR restriction is maintained
                    }
                }

                // Add status filter
                if (status === 'available') {
                    query.productQuantity = { $gt: 0 };
                } else if (status === 'unavailable') {
                    query.productQuantity = { $lte: 0 };
                }

                // Add type filter
                if (type && type !== 'all') {
                    query.productType = type;
                }

                const cursor = assetsCollection.find(query).sort({ createdAt: -1 });

                let assets;
                if (limit > 0) {
                    assets = await cursor.skip(skip).limit(limit).toArray();
                } else {
                    assets = await cursor.toArray();
                }

                const total = await assetsCollection.countDocuments(query);

                // Calculate stats for admin (based on base query, not filtered query)
                let stats = {};
                if (isAdmin) {
                    const [totalStats, availableStats, outOfStockStats] = await Promise.all([
                        assetsCollection.countDocuments(baseQuery),
                        assetsCollection.countDocuments({ ...baseQuery, productQuantity: { $gt: 0 } }),
                        assetsCollection.countDocuments({ ...baseQuery, productQuantity: { $lte: 0 } })
                    ]);

                    stats = {
                        total: totalStats,
                        available: availableStats,
                        outOfStock: outOfStockStats
                    };
                }

                // Return format based on role
                if (isAdmin) {
                    res.send({
                        assets,
                        total,
                        page,
                        totalPages: limit > 0 ? Math.ceil(total / limit) : 1,
                        hasMore: limit > 0 ? (page * limit) < total : false,
                        stats
                    });
                } else {
                    // HR expects simple array format for backward compatibility
                    // But we can also send pagination info if limit is specified
                    if (limit > 0) {
                        res.send({
                            assets,
                            total,
                            page,
                            totalPages: Math.ceil(total / limit),
                            hasMore: (page * limit) < total
                        });
                    } else {
                        res.send(assets);
                    }
                }
            } catch (error) {
                console.error('Assets endpoint error:', error);
                res.status(500).send({ message: "Error fetching assets", error: error.message });
            }
        })

        app.get("/assets/public", verifyToken, async (req, res) => {
            const searchText = req.query.searchText || "";
            const limit = parseInt(req.query.limit);
            const skip = parseInt(req.query.skip);

            let query = {};

            if (searchText) {
                query.$or = [
                    { productName: { $regex: searchText, $options: "i" } },
                    { companyName: { $regex: searchText, $options: "i" } },
                    { productType: { $regex: searchText, $options: "i" } },
                    { brand: { $regex: searchText, $options: "i" } },
                    { model: { $regex: searchText, $options: "i" } },
                    { category: { $regex: searchText, $options: "i" } }
                ];
            }

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
        });

        // HR Dashboard Analytics - Comprehensive stats for HR dashboard
        app.get("/analytics/dashboard-stats", verifyToken, async (req, res) => {
            try {
                const email = req.decoded.email;

                // Check if user is admin
                const adminUser = await admin.findOne({ email });
                const isAdmin = adminUser && adminUser.role === 'admin';

                if (isAdmin) {
                    // Admin gets system-wide stats
                    const [
                        totalAssets,
                        totalUsers,
                        totalEmployees,
                        totalHRs,
                        pendingRequests,
                        approvedRequests,
                        returnableAssets,
                        nonReturnableAssets,
                        availableAssets,
                        lowStockAssets
                    ] = await Promise.all([
                        assetsCollection.countDocuments(),
                        usersCollection.countDocuments(),
                        usersCollection.countDocuments({ role: "employee" }),
                        usersCollection.countDocuments({ role: "hr" }),
                        requestCollection.countDocuments({ status: "pending" }),
                        requestCollection.countDocuments({ status: "approved" }),
                        assetsCollection.countDocuments({ productType: "Returnable" }),
                        assetsCollection.countDocuments({ productType: "Non-returnable" }),
                        assetsCollection.countDocuments({ productQuantity: { $gt: 0 } }),
                        assetsCollection.countDocuments({ productQuantity: { $lte: 5, $gt: 0 } })
                    ]);

                    res.send({
                        totalAssets,
                        totalUsers,
                        totalEmployees,
                        totalHRs,
                        pendingRequests,
                        approvedRequests,
                        returnableAssets,
                        nonReturnableAssets,
                        availableAssets,
                        assignedAssets: totalAssets - availableAssets,
                        lowStockAssets,
                        monthlyRequests: pendingRequests + approvedRequests
                    });
                } else {
                    // Check if user is HR
                    const hrUser = await usersCollection.findOne({ email, role: "hr" });

                    if (hrUser) {
                        // HR gets organization-specific stats
                        const [
                            totalAssets,
                            totalEmployees,
                            pendingRequests,
                            approvedRequests,
                            returnableAssets,
                            nonReturnableAssets,
                            availableAssets,
                            lowStockAssets
                        ] = await Promise.all([
                            assetsCollection.countDocuments({ hrEmail: email }),
                            usersCollection.countDocuments({
                                role: "employee",
                                "affiliations.hrEmail": email
                            }),
                            requestCollection.countDocuments({ hrEmail: email, status: "pending" }),
                            requestCollection.countDocuments({ hrEmail: email, status: "approved" }),
                            assetsCollection.countDocuments({ hrEmail: email, productType: "Returnable" }),
                            assetsCollection.countDocuments({ hrEmail: email, productType: "Non-returnable" }),
                            assetsCollection.countDocuments({ hrEmail: email, productQuantity: { $gt: 0 } }),
                            assetsCollection.countDocuments({
                                hrEmail: email,
                                productQuantity: { $lte: 5, $gt: 0 }
                            })
                        ]);

                        res.send({
                            totalAssets,
                            totalEmployees,
                            pendingRequests,
                            approvedRequests,
                            returnableAssets,
                            nonReturnableAssets,
                            availableAssets,
                            assignedAssets: totalAssets - availableAssets,
                            lowStockAssets,
                            monthlyRequests: pendingRequests + approvedRequests
                        });
                    } else {
                        // Employee gets personal stats
                        const employeeUser = await usersCollection.findOne({ email, role: "employee" });

                        if (employeeUser) {
                            const [
                                myPendingRequests,
                                myApprovedRequests,
                                myAssets,
                                teamMembers
                            ] = await Promise.all([
                                requestCollection.countDocuments({ employeeEmail: email, status: "pending" }),
                                requestCollection.countDocuments({ employeeEmail: email, status: "approved" }),
                                requestCollection.countDocuments({ employeeEmail: email, status: "approved" }), // Approved requests = assigned assets
                                usersCollection.countDocuments({
                                    role: "employee",
                                    "affiliations.hrEmail": employeeUser.affiliations?.[0]?.hrEmail || ""
                                })
                            ]);

                            res.send({
                                myAssets,
                                myPendingRequests,
                                myApprovedRequests,
                                teamMembers: teamMembers - 1 // Exclude self
                            });
                        } else {
                            res.status(404).send({ message: "User not found" });
                        }
                    }
                }
            } catch (error) {
                console.error('Dashboard stats error:', error);
                res.status(500).send({ message: "Server error" });
            }
        });

        // HR Analytics - Monthly trends data
        app.get("/analytics/monthly-trends", verifyToken, verifyHR, async (req, res) => {
            try {
                const hrEmail = req.decoded.email;

                // Get data for the last 6 months
                const sixMonthsAgo = new Date();
                sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

                // Aggregate requests by month
                const requestTrends = await requestCollection.aggregate([
                    {
                        $match: {
                            hrEmail: hrEmail,
                            createdAt: { $gte: sixMonthsAgo }
                        }
                    },
                    {
                        $group: {
                            _id: {
                                year: { $year: "$createdAt" },
                                month: { $month: "$createdAt" }
                            },
                            totalRequests: { $sum: 1 },
                            approvedRequests: {
                                $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] }
                            }
                        }
                    },
                    { $sort: { "_id.year": 1, "_id.month": 1 } }
                ]).toArray();

                // Aggregate assets by month
                const assetTrends = await assetsCollection.aggregate([
                    {
                        $match: {
                            hrEmail: hrEmail,
                            createdAt: { $gte: sixMonthsAgo }
                        }
                    },
                    {
                        $group: {
                            _id: {
                                year: { $year: "$createdAt" },
                                month: { $month: "$createdAt" }
                            },
                            assetsAdded: { $sum: 1 }
                        }
                    },
                    { $sort: { "_id.year": 1, "_id.month": 1 } }
                ]).toArray();

                // Create month labels
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                const result = [];

                for (let i = 5; i >= 0; i--) {
                    const date = new Date();
                    date.setMonth(date.getMonth() - i);
                    const year = date.getFullYear();
                    const month = date.getMonth() + 1;

                    const requestData = requestTrends.find(r => r._id.year === year && r._id.month === month);
                    const assetData = assetTrends.find(a => a._id.year === year && a._id.month === month);

                    result.push({
                        month: months[month - 1],
                        requests: requestData?.totalRequests || 0,
                        approvals: requestData?.approvedRequests || 0,
                        assets: assetData?.assetsAdded || 0
                    });
                }

                res.send(result);
            } catch (error) {
                console.error('Monthly trends error:', error);
                res.status(500).send({ message: "Server error" });
            }
        });

        // HR Analytics - Asset status distribution
        app.get("/analytics/asset-status", verifyToken, verifyHR, async (req, res) => {
            try {
                const hrEmail = req.decoded.email;

                const [
                    availableAssets,
                    assignedAssets,
                    lowStockAssets,
                    totalAssets
                ] = await Promise.all([
                    assetsCollection.countDocuments({ hrEmail, productQuantity: { $gt: 5 } }),
                    requestCollection.countDocuments({ hrEmail, status: "approved" }),
                    assetsCollection.countDocuments({ hrEmail, productQuantity: { $lte: 5, $gt: 0 } }),
                    assetsCollection.countDocuments({ hrEmail })
                ]);

                const outOfStockAssets = await assetsCollection.countDocuments({
                    hrEmail,
                    productQuantity: { $lte: 0 }
                });

                const result = [
                    {
                        status: "Available",
                        count: availableAssets,
                        percentage: totalAssets > 0 ? Math.round((availableAssets / totalAssets) * 100) : 0
                    },
                    {
                        status: "Assigned",
                        count: assignedAssets,
                        percentage: totalAssets > 0 ? Math.round((assignedAssets / totalAssets) * 100) : 0
                    },
                    {
                        status: "Low Stock",
                        count: lowStockAssets,
                        percentage: totalAssets > 0 ? Math.round((lowStockAssets / totalAssets) * 100) : 0
                    },
                    {
                        status: "Out of Stock",
                        count: outOfStockAssets,
                        percentage: totalAssets > 0 ? Math.round((outOfStockAssets / totalAssets) * 100) : 0
                    }
                ];

                res.send(result);
            } catch (error) {
                console.error('Asset status error:', error);
                res.status(500).send({ message: "Server error" });
            }
        });

        // Return routes MUST come before /assets/:id to avoid route conflicts
        // Return an asset (Employee only)
        app.patch("/assets/return", verifyToken, verifyEmployee, async (req, res) => {
            try {
                console.log("🔄 Return asset request received:", req.body);
                console.log("🔄 Employee email:", req.decoded.email);

                const { assetId } = req.body;
                const employeeEmail = req.decoded.email;

                if (!assetId) {
                    console.log("❌ No asset ID provided");
                    return res.status(400).send({ message: "Asset ID is required" });
                }

                console.log("🔄 Asset ID received:", assetId);

                // Convert assetId to ObjectId for database queries
                let assetObjectId;
                try {
                    assetObjectId = new ObjectId(assetId);
                } catch (error) {
                    console.log("❌ Invalid asset ID format:", error.message);
                    return res.status(400).send({ message: "Invalid asset ID format" });
                }

                // Find the asset
                const asset = await assetsCollection.findOne({ _id: assetObjectId });
                console.log("🔍 Found asset:", asset ? `${asset.productName} (${asset.productType})` : "No asset found");
                if (!asset) {
                    return res.status(404).send({ message: "Asset not found" });
                }

                // Check if asset is returnable
                if (asset.productType !== "Returnable") {
                    console.log("❌ Asset is not returnable:", asset.productType);
                    return res.status(400).send({ message: "This asset is not returnable" });
                }

                // Check if the asset is assigned to this employee
                const employee = await usersCollection.findOne({ email: employeeEmail });
                console.log("👤 Employee found:", employee ? `${employee.name} with ${employee.assets?.length || 0} assets` : "No employee found");

                if (!employee || !employee.assets) {
                    return res.status(400).send({ message: "No assets assigned to you" });
                }

                // Find the asset in employee's assets (compare ObjectId properly)
                const assignedAsset = employee.assets.find(a => {
                    // Handle both string and ObjectId formats
                    const employeeAssetId = typeof a.assetId === 'string' ? a.assetId : a.assetId.toString();
                    const requestAssetId = assetId.toString();
                    return employeeAssetId === requestAssetId;
                });

                console.log("🔍 Employee has asset:", assignedAsset ? "Yes" : "No");
                if (!assignedAsset) {
                    console.log("📋 Employee assets:", employee.assets.map(a => ({ id: a.assetId, name: a.productName })));
                    return res.status(400).send({ message: "Asset is not assigned to you" });
                }

                console.log("🔄 Starting asset return process...");

                // Update asset - increment quantity and set to available
                const assetUpdateResult = await assetsCollection.updateOne(
                    { _id: assetObjectId },
                    {
                        $inc: { productQuantity: 1 },
                        $set: {
                            status: "Available",
                            assignedTo: null,
                            assignedEmployeeName: null,
                            assignedDate: null,
                            updatedAt: new Date()
                        }
                    }
                );
                console.log("📦 Asset updated:", assetUpdateResult.modifiedCount > 0 ? "Yes" : "No");

                // Remove asset from employee's assets (use proper ObjectId comparison)
                const employeeUpdateResult = await usersCollection.updateOne(
                    { email: employeeEmail },
                    {
                        $pull: {
                            assets: {
                                assetId: assetObjectId
                            }
                        },
                        $set: { updatedAt: new Date() }
                    }
                );
                console.log("👤 Employee updated:", employeeUpdateResult.modifiedCount > 0 ? "Yes" : "No");

                // Update the asset request status to returned
                const requestUpdateResult = await requestCollection.updateOne(
                    { assetId: assetObjectId, employeeEmail: employeeEmail, status: "approved" },
                    {
                        $set: {
                            status: "returned",
                            returnDate: new Date(),
                            updatedAt: new Date()
                        }
                    }
                );
                console.log("📝 Request updated:", requestUpdateResult.modifiedCount > 0 ? "Yes" : "No");

                console.log("✅ Asset return completed successfully");
                res.send({
                    success: true,
                    message: "Asset returned successfully and is now available for other employees"
                });

            } catch (err) {
                console.error("❌ Return asset error:", err);
                res.status(500).send({ message: "Server error", error: err.message });
            }
        });

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
                    ...req.body,
                    updatedAt: new Date()
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


            await assetsCollection.updateOne(
                assetQuery,
                {
                    $set: {
                        status: "Assigned",
                        assignedTo: request.employeeEmail,
                        assignedEmployeeName: request.employeeName || "Unknown",
                        assignedDate: new Date(),
                        updatedAt: new Date(),
                    },
                    $inc: {
                        productQuantity: -1,
                        requestCount: 1
                    }
                }
            );

            const employeeEmail = { email: request.employeeEmail }

            const pushAsset = {
                $push: {
                    assets: {
                        assetId: asset._id,
                        assetCode: asset.assetCode,
                        productName: asset.productName,
                        productImage: asset.productImage,
                        productType: asset.productType,
                        category: asset.category,
                        brand: asset.brand,
                        model: asset.model,
                        companyName: asset.companyName,
                        hrEmail: asset.hrEmail,
                        assignedDate: new Date(),
                        status: "Assigned"
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

        // Test endpoint
        app.get("/test", (req, res) => {
            console.log("Test endpoint hit");
            res.send({ message: "Server is working!" });
        });

        // Test authenticated endpoint
        app.get("/test-auth", verifyToken, (req, res) => {
            console.log("Authenticated test endpoint hit by:", req.decoded.email);
            res.send({ message: "Authentication working!", user: req.decoded });
        });

        // ============= ADMIN APIs =============

        // Admin - Update admin profile
        const { assetId } = req.body;
        const employeeEmail = req.decoded.email;
        console.log("Employee email:", employeeEmail, "Asset ID:", assetId);

        if (!assetId) {
            return res.status(400).send({ message: "Asset ID is required" });
        }

        // Convert assetId to ObjectId for database queries
        let assetObjectId;
        try {
            assetObjectId = new ObjectId(assetId);
        } catch (error) {
            return res.status(400).send({ message: "Invalid asset ID format" });
        }

        // Find the asset
        const asset = await assetsCollection.findOne({ _id: assetObjectId });
        console.log("Found asset:", asset ? `${asset.productName} (${asset.productType})` : "No");
        if (!asset) {
            return res.status(404).send({ message: "Asset not found" });
        }

        // Check if asset is returnable
        if (asset.productType !== "Returnable") {
            return res.status(400).send({ message: "This asset is not returnable" });
        }

        // Check if the asset is assigned to this employee
        const employee = await usersCollection.findOne({ email: employeeEmail });
        console.log("Employee found:", employee ? `${employee.name} with ${employee.assets?.length || 0} assets` : "No");

        if (!employee || !employee.assets) {
            return res.status(400).send({ message: "No assets assigned to you" });
        }

        // Find the asset in employee's assets (compare ObjectId properly)
        const assignedAsset = employee.assets.find(a => {
            // Handle both string and ObjectId formats
            const employeeAssetId = typeof a.assetId === 'string' ? a.assetId : a.assetId.toString();
            const requestAssetId = assetId.toString();
            return employeeAssetId === requestAssetId;
        });

        console.log("Employee has asset:", assignedAsset ? "Yes" : "No");
        if (!assignedAsset) {
            console.log("Employee assets:", employee.assets.map(a => ({ id: a.assetId, name: a.productName })));
            return res.status(400).send({ message: "Asset is not assigned to you" });
        }

        // Update asset - increment quantity and set to available
        const assetUpdateResult = await assetsCollection.updateOne(
            { _id: assetObjectId },
            {
                $inc: { productQuantity: 1 },
                $set: {
                    status: "Available",
                    assignedTo: null,
                    assignedEmployeeName: null,
                    assignedDate: null,
                    updatedAt: new Date()
                }
            }
        );
        console.log("Asset updated:", assetUpdateResult.modifiedCount > 0 ? "Yes" : "No");

        // Remove asset from employee's assets (use proper ObjectId comparison)
        const employeeUpdateResult = await usersCollection.updateOne(
            { email: employeeEmail },
            {
                $pull: {
                    assets: {
                        assetId: assetObjectId
                    }
                },
                $set: { updatedAt: new Date() }
            }
        );
        console.log("Employee updated:", employeeUpdateResult.modifiedCount > 0 ? "Yes" : "No");

        // Update the asset request status to returned
        const requestUpdateResult = await requestCollection.updateOne(
            { assetId: assetObjectId, employeeEmail: employeeEmail, status: "approved" },
            {
                $set: {
                    status: "returned",
                    returnDate: new Date(),
                    updatedAt: new Date()
                }
            }
        );
        console.log("Request updated:", requestUpdateResult.modifiedCount > 0 ? "Yes" : "No");

        console.log("✅ Asset return completed successfully");
        res.send({
            success: true,
            message: "Asset returned successfully and is now available for other employees"
        });

    } catch (err) {
        console.error("Return asset error:", err);
        res.status(500).send({ message: "Server error", error: err.message });
    }


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

                await assetsCollection.updateOne(
                    { _id: request.assetId },
                    {
                        $set: {
                            status: "Available",
                            assignedTo: null,
                            assignedEmployeeName: null,
                            assignedDate: null,
                            updatedAt: new Date()
                        }
                    }
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

    // ============= ADMIN APIs =============

    // Admin - Update admin profile
    app.patch("/admin/:email", verifyToken, verifyAdmin, async (req, res) => {
        try {
            const email = req.params.email;
            const decodedEmail = req.decoded.email;

            if (email !== decodedEmail) {
                return res.status(403).send({ message: "Forbidden access" });
            }

            const updatedData = req.body;
            // Prevent updating sensitive fields
            delete updatedData.role;
            delete updatedData.email;
            delete updatedData._id;

            // Add updated timestamp
            updatedData.updatedAt = new Date();

            const result = await admin.updateOne(
                { email },
                { $set: updatedData }
            );

            if (result.matchedCount === 0) {
                return res.status(404).send({ message: "Admin not found" });
            }

            res.send({ success: true, message: "Admin profile updated successfully" });
        } catch (error) {
            console.error("Admin update error:", error);
            res.status(500).send({ message: "Server error" });
        }
    });

    // Admin Dashboard Analytics - System-wide stats
    app.get("/admin/analytics/overview", verifyToken, verifyAdmin, async (req, res) => {
        try {
            const totalUsers = await usersCollection.countDocuments();
            const totalHRs = await usersCollection.countDocuments({ role: "hr" });
            const totalEmployees = await usersCollection.countDocuments({ role: "employee" });
            const totalAssets = await assetsCollection.countDocuments();
            const totalRequests = await requestCollection.countDocuments();
            const pendingRequests = await requestCollection.countDocuments({ status: "pending" });
            const approvedRequests = await requestCollection.countDocuments({ status: "approved" });

            // Active organizations (HRs with at least 1 employee)
            const activeOrganizations = await usersCollection.countDocuments({
                role: "hr",
                currentEmployees: { $gt: 0 }
            });

            res.send({
                totalUsers,
                totalHRs,
                totalEmployees,
                totalAssets,
                totalRequests,
                pendingRequests,
                approvedRequests,
                activeOrganizations
            });
        } catch (error) {
            console.error(error);
            res.status(500).send({ message: "Server error" });
        }
    });

    // Admin - Get all users with pagination and filters
    app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const role = req.query.role;
            const search = req.query.search || "";

            const skip = (page - 1) * limit;

            let query = {};
            if (role && role !== "all") {
                query.role = role;
            }
            if (search) {
                query.$or = [
                    { name: { $regex: search, $options: "i" } },
                    { email: { $regex: search, $options: "i" } },
                    { companyName: { $regex: search, $options: "i" } }
                ];
            }

            const users = await usersCollection
                .find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            const total = await usersCollection.countDocuments(query);

            // Calculate real-time stats (based on all users, not filtered)
            const [totalUsers, hrCount, employeeCount] = await Promise.all([
                usersCollection.countDocuments({}),
                usersCollection.countDocuments({ role: 'hr' }),
                usersCollection.countDocuments({ role: 'employee' })
            ]);

            const stats = {
                totalUsers,
                hrCount,
                employeeCount
            };

            res.send({
                users,
                total,
                page,
                totalPages: Math.ceil(total / limit),
                stats
            });
        } catch (error) {
            console.error(error);
            res.status(500).send({ message: "Server error" });
        }
    });

    // Admin - Get all organizations (HR users)
    app.get("/admin/organizations", verifyToken, verifyAdmin, async (req, res) => {
        try {
            const organizations = await usersCollection
                .find({ role: "hr" })
                .project({
                    name: 1,
                    email: 1,
                    companyName: 1,
                    companyLogo: 1,
                    subscription: 1,
                    packageLimit: 1,
                    currentEmployees: 1,
                    paid: 1,
                    createdAt: 1
                })
                .sort({ createdAt: -1 })
                .toArray();

            // Get asset counts for each organization
            const orgsWithAssets = await Promise.all(
                organizations.map(async (org) => {
                    const assetCount = await assetsCollection.countDocuments({ hrEmail: org.email });
                    return { ...org, assetCount };
                })
            );

            res.send(orgsWithAssets);
        } catch (error) {
            console.error(error);
            res.status(500).send({ message: "Server error" });
        }
    });

    // Admin - Get all assets across all organizations
    app.get("/admin/assets", verifyToken, verifyAdmin, async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const search = req.query.search || "";
            const type = req.query.type;
            const status = req.query.status;

            const skip = (page - 1) * limit;

            let query = {};
            if (search) {
                query.$or = [
                    { productName: { $regex: search, $options: "i" } },
                    { companyName: { $regex: search, $options: "i" } },
                    { hrEmail: { $regex: search, $options: "i" } }
                ];
            }
            if (type && type !== "all") {
                query.productType = type;
            }
            if (status && status !== "all") {
                query.status = status;
            }

            const assets = await assetsCollection
                .find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            const total = await assetsCollection.countDocuments(query);

            res.send({
                assets,
                total,
                page,
                totalPages: Math.ceil(total / limit)
            });
        } catch (error) {
            console.error(error);
            res.status(500).send({ message: "Server error" });
        }
    });

    // Admin - System-wide asset analytics
    app.get("/admin/analytics/assets", verifyToken, verifyAdmin, async (req, res) => {
        try {
            // Asset type distribution
            const assetTypes = await assetsCollection.aggregate([
                { $group: { _id: "$productType", count: { $sum: 1 } } }
            ]).toArray();

            // Asset status distribution (based on quantity)
            const assetStatus = await assetsCollection.aggregate([
                {
                    $group: {
                        _id: {
                            $cond: [
                                { $gt: ["$productQuantity", 0] },
                                "Available",
                                "Out of Stock"
                            ]
                        },
                        count: { $sum: 1 }
                    }
                }
            ]).toArray();

            // Top organizations by asset count (with better organization data)
            const topOrganizations = await assetsCollection.aggregate([
                {
                    $group: {
                        _id: "$hrEmail",
                        count: { $sum: 1 },
                        companyName: { $first: "$companyName" }
                    }
                },
                {
                    $lookup: {
                        from: "users",
                        localField: "_id",
                        foreignField: "email",
                        as: "hrInfo"
                    }
                },
                {
                    $addFields: {
                        organizationName: {
                            $cond: [
                                { $and: [{ $ne: ["$companyName", null] }, { $ne: ["$companyName", ""] }] },
                                "$companyName",
                                {
                                    $cond: [
                                        { $gt: [{ $size: "$hrInfo" }, 0] },
                                        { $arrayElemAt: ["$hrInfo.companyName", 0] },
                                        { $arrayElemAt: [{ $split: ["$_id", "@"] }, 0] }
                                    ]
                                }
                            ]
                        }
                    }
                },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]).toArray();

            // Monthly asset creation trends (last 6 months)
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

            const monthlyTrends = await assetsCollection.aggregate([
                { $match: { createdAt: { $gte: sixMonthsAgo } } },
                {
                    $group: {
                        _id: {
                            year: { $year: "$createdAt" },
                            month: { $month: "$createdAt" }
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { "_id.year": 1, "_id.month": 1 } }
            ]).toArray();

            // Format the response data for charts
            res.send({
                assetTypes: assetTypes.map(item => ({
                    name: item._id || 'Unknown',
                    value: item.count
                })),
                assetStatus: assetStatus.map(item => ({
                    name: item._id || 'Unknown',
                    value: item.count
                })),
                topOrganizations: topOrganizations.map(item => ({
                    name: item.organizationName || item.companyName || item._id?.split('@')[0] || 'Unknown Organization',
                    assets: item.count,
                    hrEmail: item._id
                })),
                monthlyTrends: monthlyTrends.map(item => ({
                    month: `${item._id.year}-${item._id.month.toString().padStart(2, '0')}`,
                    assets: item.count
                }))
            });
        } catch (error) {
            console.error('Admin asset analytics error:', error);
            res.status(500).send({ message: "Server error" });
        }
    });

    // Admin - Get all requests across all organizations
    app.get("/admin/requests", verifyToken, verifyAdmin, async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const status = req.query.status;

            const skip = (page - 1) * limit;

            let query = {};
            if (status && status !== "all") {
                query.status = status;
            }

            const requests = await requestCollection
                .find(query)
                .sort({ requestDate: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            const total = await requestCollection.countDocuments(query);

            res.send({
                requests,
                total,
                page,
                totalPages: Math.ceil(total / limit)
            });
        } catch (error) {
            console.error(error);
            res.status(500).send({ message: "Server error" });
        }
    });

    // Admin - Update user status (activate/deactivate)
    app.patch("/admin/users/:id/status", verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body; // 'active' or 'inactive'

            const result = await usersCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status, updatedAt: new Date() } }
            );

            if (result.matchedCount === 0) {
                return res.status(404).send({ message: "User not found" });
            }

            res.send({ success: true, message: `User ${status === 'active' ? 'activated' : 'deactivated'} successfully` });
        } catch (error) {
            console.error(error);
            res.status(500).send({ message: "Server error" });
        }
    });

    // Admin - Delete user (with proper cleanup)
    app.delete("/admin/users/:id", verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const user = await usersCollection.findOne({ _id: new ObjectId(id) });

            if (!user) {
                return res.status(404).send({ message: "User not found" });
            }

            // If deleting HR, clean up their assets and employee affiliations
            if (user.role === "hr") {
                // Delete all assets belonging to this HR
                await assetsCollection.deleteMany({ hrEmail: user.email });

                // Remove affiliations from employees
                await usersCollection.updateMany(
                    { "affiliations.hrEmail": user.email },
                    { $pull: { affiliations: { hrEmail: user.email } } }
                );

                // Delete all requests related to this HR
                await requestCollection.deleteMany({ hrEmail: user.email });
            }

            // If deleting employee, clean up their asset assignments
            if (user.role === "employee" && user.assets && user.assets.length > 0) {
                // Return assets to available status
                for (const asset of user.assets) {
                    await assetsCollection.updateOne(
                        { _id: asset.assetId },
                        {
                            $set: {
                                status: "Available",
                                assignedTo: null,
                                assignedEmployeeName: null,
                                assignedDate: null
                            },
                            $inc: { productQuantity: 1 }
                        }
                    );
                }

                // Update HR employee count
                if (user.affiliations && user.affiliations.length > 0) {
                    for (const affiliation of user.affiliations) {
                        await usersCollection.updateOne(
                            { email: affiliation.hrEmail },
                            { $inc: { currentEmployees: -1 } }
                        );
                    }
                }
            }

            // Delete the user
            await usersCollection.deleteOne({ _id: new ObjectId(id) });

            res.send({ success: true, message: "User deleted successfully" });
        } catch (error) {
            console.error(error);
            res.status(500).send({ message: "Server error" });
        }
    });

    // ============= END ADMIN APIs =============












    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
} finally {

}

run().catch(console.dir);


app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
