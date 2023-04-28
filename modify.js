const { MongoClient } = require("mongodb");
const ethers = require("ethers");
require("dotenv").config();
const fs = require("fs");
const pinataSDK = require("@pinata/sdk");

const uri = process.env.MONGO_URL;
const dbName = process.env.MONGO_DB_NAME;
const collectionName = process.env.MONGO_COLLECTION_NAME;
const interval = 10000; // 5 seconds
const edenApiKey = process.env.EDEN_API_KEY;
const edenApiSecret = process.env.EDEN_API_SECRET;
const pinataApiKey = process.env.PINATA_API_KEY;
const pinataApiSecret = process.env.PINATA_API_SECRET;

const LivemintAbi = require("../contracts/out/EdenLivemint.sol/EdenLivemint.json");

const getLiveMintAddress = () => {
  const broadcast = "../contracts/broadcast/Deploy.s.sol/1337/run-latest.json";
  const broadcastInfo = fs.readFileSync(broadcast, "utf8");
  const parsed = JSON.parse(broadcastInfo);
  const deployments = parsed.transactions.filter(
    (tx) => tx.transactionType === "CREATE"
  );
  return deployments[0].contractAddress;
};

const getSigner = (provider) => {
  SIGNER_PK = process.env.SIGNER_PK;
  const signer = new ethers.Wallet(SIGNER_PK, provider);
  return signer;
};

const getContract = (provider) => {
  const livemintAddress = getLiveMintAddress();
  const signer = getSigner(provider);
  const Livemint = new ethers.Contract(
    livemintAddress,
    LivemintAbi.abi,
    signer
  );

  return Livemint;
};

const modifyMetadata = async (livemint, tokenId, imageUri) => {
  console.log("modifying metadata for tokenId", tokenId);
  const tx = await livemint.setTokenURI(tokenId, imageUri, {
    gasLimit: 10000000,
  });
  console.log("submitting tx", tx.hash);
  const receipt = await tx.wait();
  const isSuccess = receipt.status === 1;
  console.log("tx success", isSuccess);
  return isSuccess;
};

const main = async () => {
  const PROVIDER_URL = process.env.PROVIDER_URL;
  const provider = ethers.getDefaultProvider(PROVIDER_URL);
  const Livemint = getContract(provider);

  const edenSdk = await import("eden-sdk");
  const { EdenClient } = edenSdk;
  const edenClient = new EdenClient(edenApiKey, edenApiSecret);

  const clientMongo = new MongoClient(uri);
  await clientMongo.connect();

  const db = clientMongo.db(dbName);
  const collection = db.collection(collectionName);

  const pinata = new pinataSDK(pinataApiKey, pinataApiSecret);

  const pinToPinata = async (imageUri) => {
    const metadata = {
      name: "Eden Livemint",
      description: "This is an NFT from Eden Livemint",
      image: imageUri,
      thumbnail: imageUri,
      external_url: "https://app.eden.art",
    };
    const pinataUrl = await pinata.pinJSONToIPFS(metadata);
    return `https://gateway.pinata.cloud/ipfs/${pinataUrl.IpfsHash}`;
  };

  const failureUpdate = async (taskId) => {
    const filter = { taskId: taskId };
    const update = { $set: { ack: true, edenSuccess: false } };
    const options = { upsert: true };
    await collection.updateMany(filter, update, options);
  };

  const txUpdate = async (taskId, txSuccess, imageUri) => {
    const filter = { taskId: taskId };
    const update = {
      $set: {
        ack: true,
        edenSuccess: true,
        imageUri: imageUri,
        txSuccess,
      },
    };
    const options = { upsert: true };
    await collection.updateMany(filter, update, options);
  };

  const handleEdenResults = async (mints) => {
    const taskIds = mints.map((mintEvent) => mintEvent.taskId);
    try {
      const { tasks } = await edenClient.getTasks({ taskIds: taskIds });
      let creationIds = [];
      tasks.forEach(async (task, idx) => {
        if (task.status === "failed") {
          await failureUpdate(task.taskId);
        }
        if (task.status === "completed") {
          const creation = await edenClient.getCreation(task.creation);
          const imageUri = creation.uri;
          const tokenId = mints[idx].tokenId;
          console.log("For tokenId", tokenId, "imageUri is", imageUri);
          const metadataUri = await pinToPinata(imageUri);
          const txSuccess = await modifyMetadata(
            Livemint,
            tokenId,
            metadataUri
          );
          console.log(task.taskId, txSuccess, imageUri);
          await txUpdate(task.taskId, txSuccess, imageUri);
        }
      });
      return creationIds;
    } catch (error) {
      console.error("Error fetching Eden results:", error);
      return;
    }
  };

  async function fetchUnacknowledgedMintEvents() {
    try {
      const query = { ack: false };
      const result = await collection.find(query).toArray();

      if (result.length === 0) {
        console.log("No unacknowledged MintEvent found.");
        return;
      }

      console.log(`Found ${result.length} unacknowledged MintEvent(s)`);

      await handleEdenResults(result);

      return result;
    } catch (error) {
      console.error("Error fetching unacknowledged MintEvent data:", error);
      return;
    }
  }

  fetchUnacknowledgedMintEvents();
  setInterval(fetchUnacknowledgedMintEvents, interval);
};

main();
