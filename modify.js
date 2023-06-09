const { MongoClient } = require("mongodb");
const axios = require('axios');
const ethers = require("ethers");
require("dotenv").config();
const fs = require("fs");
const pinataSDK = require("@pinata/sdk");

const livemintAbi = require("eden-contracts/out/EdenLivemint.sol/EdenLivemint.json");
const broadcastInfo = require("eden-contracts/broadcast/Deploy.s.sol/5/run-latest.json");

const uri = process.env.MONGO_URL;
const dbName = process.env.MONGO_DB_NAME;
const collectionName = process.env.MONGO_COLLECTION_NAME;
const edenApiKey = process.env.EDEN_API_KEY;
const edenApiSecret = process.env.EDEN_API_SECRET;
const pinataApiKey = process.env.PINATA_API_KEY;
const pinataApiSecret = process.env.PINATA_API_SECRET;


const getLiveMintAddress = () => {
  const deployments = broadcastInfo.transactions.filter(
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
  console.log("livemintAddress", livemintAddress);
  const signer = getSigner(provider);
  const Livemint = new ethers.Contract(
    livemintAddress,
    livemintAbi.abi,
    signer
  );
  return Livemint;
};

const modifyMetadata = async (provider, livemint, tokenId, imageUri) => {
  const tx = await livemint.setTokenURI(tokenId, imageUri, {
    gasLimit: 10000000,
  });
  const receipt = await tx.wait();
  if (receipt.status === 0) {
    console.log("Transaction failed:", receipt.transactionHash);
    const reason = await provider.getTransactionReceipt(receipt.transactionHash)
      .then((txReceipt) => {
        const logs = livemint.interface.parseLog(txReceipt.logs[0]);
        return logs.args[1];
      })
      .catch((err) => {
        console.error("Error getting transaction receipt:", err);
        return "Unknown reason";
      });
    console.log("Reason:", reason);
    return false;
  }
  console.log(`tx success == ${receipt.status}, ${tx.hash}`);
  return receipt.status;
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
      for (task of tasks) {
        console.log("task", task.status, task.taskId);
        if (task.status === "failed") {
          const filter = { taskId: task.taskId };
          const update = { $set: { ack: true, edenSuccess: false } };
          const options = { upsert: true };
          await collection.updateMany(filter, update, options);
        }
        if (task.status === "completed") {
          const creation = await edenClient.getCreation(task.creation);
          const imageUri = creation.uri;
          const tokenId = mints.find((mint) => mint.taskId === task.taskId).tokenId;
          const filename = imageUri.split('/').slice(-1)[0];
          const imageStream = await axios({
            url: imageUri,
            method: 'GET',
            responseType: 'stream'
          });
          const ipfsImage = await pinata.pinFileToIPFS(imageStream.data, {
            pinataMetadata: {
              name: filename
            }
          });
          console.log("upload", ipfsImage)
          const ipfsImageUri = `https://gateway.pinata.cloud/ipfs/${ipfsImage.IpfsHash}`
          console.log("ipfsImageUri", ipfsImageUri);
          console.log(creation);
          const metadata = {
            name: "Eden Livemint",
            description: `${creation.name}`,
            image: ipfsImageUri,
            thumbnail: ipfsImageUri,
            external_url: `https://garden.eden.art/creation/${creation._id}`,
          };
          console.log("METADATA", metadata)
          const pinataUrl = await pinata.pinJSONToIPFS(metadata);
          const metadataUri = `https://gateway.pinata.cloud/ipfs/${pinataUrl.IpfsHash}`
          const txSuccess = await modifyMetadata(
            provider,
            Livemint,
            tokenId,
            metadataUri
          );
          const filter = { taskId: task.taskId };
          const options = { upsert: true };
          const update = {
            $set: {
              ack: true,
              edenSuccess: true,
              imageUri: imageUri,
              ipfsUri: ipfsImageUri,
              ipfsImageUri: ipfsImageUri,
              txSuccess,
            },
          };
          await collection.updateMany(filter, update, options);
        }
      }
      return;
    } catch (error) {
      console.error("Error fetching Eden results:", error);
      return;
    }
  };

  async function fetchUnacknowledgedMintEvents() {
    try {
      console.log("Fetching unacknowledged MintEvents...");

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

  async function runCodeWithInterval() {
    while (true) {
      await fetchUnacknowledgedMintEvents();
      await new Promise((resolve) => setTimeout(resolve, 2000)); // wait for 1 second
    }
  }
  
  await runCodeWithInterval();

};

main();
