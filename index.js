require('dotenv').config();
const express = require('express')
const cors = require('cors')
const app = express()
// const crypto = require("crypto");
const port = process.env.PORT || 3000
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");


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

        // global api
        app.get('/', (req, res) => {
            res.send('Asset Verse Server is Running')
        })

        // packages api
        app.get('/packages', async (req, res) => {
            const cursor = packagesCollection.find()
            const result = await cursor.toArray()
            res.send(result)
        })

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

        app.get('/users/:email', verifyToken, async (req, res) => {
            const email = req.params.email
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            const result = await usersCollection.findOne({ email })
            res.send(result)
        })

        app.get("/users", verifyToken, verifyHR, async (req, res) => {
            const result = await usersCollection.find().toArray();
            res.send(result);
        });

        app.get('/users/:email/role', verifyToken, async (req, res) => {
            const decodecEmail = req.decoded.email
            const reqEmail = req.params.email
            if (decodecEmail !== reqEmail) {
                return res.status(403).send({ message: 'Forbidden' });
            }

            const user = await usersCollection.findOne({ email: req.params.email });
            res.send({ role: user?.role || 'employee' });
        });

        // assets apis
        app.post('/assets', verifyToken, verifyHR, async (req, res) => {
            const asset = req.body
            asset.createdAt = new Date()
            const result = await assetsCollection.insertOne(asset)
            res.send(result)
        })

        app.get("/assets", verifyToken, verifyHR, async (req, res) => {
            const email = req.decoded.email;
            const result = await assetsCollection.find({ hrEmail: email }).sort({ createdAt: -1 }).toArray();
            res.send(result);
        });

        app.patch('/assets/:id', verifyToken, verifyHR, async (req, res) => {
            const id = req.params.id;
            const { productName, productImage, productType, productQuantity } = req.body;
            const asset = await assetsCollection.findOne({
                _id: new ObjectId(id)
            });

            if (!asset) {
                return res.status(404).send({ message: "Asset not found" });
            }

            if (asset.hrEmail !== req.decoded.email) {
                return res.status(403).send({
                    message: "You can only edit assets you created"
                });
            }

            const assignedQuantity =
                Number(asset.productQuantity) - Number(asset.availableQuantity);
            const newproductQuantity =
                productQuantity !== undefined
                    ? Number(productQuantity)
                    : asset.productQuantity;

            if (newproductQuantity < assignedQuantity) {
                return res.status(400).send({
                    message: "Total quantity cannot be less than assigned assets"
                });
            }

            const updateDoc = {
                $set: {
                    productName: productName || asset.productName,
                    productImage: productImage || asset.productImage,
                    productType: productType || asset.productType,
                    productQuantity: newproductQuantity,
                    availableQuantity: newproductQuantity - assignedQuantity,
                }
            };
            const result = await assetsCollection.updateOne(
                { _id: new ObjectId(id) },
                updateDoc
            );
            res.send({ result });
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


        // await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {

    }
}
run().catch(console.dir);


app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
