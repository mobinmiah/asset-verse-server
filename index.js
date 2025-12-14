require('dotenv').config();
const express = require('express')
const cors = require('cors')
const app = express()
// const crypto = require("crypto");
const port = process.env.PORT || 3000

// middle wares
app.use(cors())
app.use(express.json())




const { MongoClient, ServerApiVersion } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.9hcy35q.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});



async function run() {
    try {
        await client.connect();

        const db = client.db("assetVerseDB")
        const packagesCollection = db.collection("packages")
        const usersCollection= db.collection("users")

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

        app.get("/users", async (req, res) => {
            const result = await users.find().toArray();
            res.send(result);
        });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {

    }
}
run().catch(console.dir);


app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
