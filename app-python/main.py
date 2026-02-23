# app-python/app.py
import os
import time
from datetime import datetime
from flask import Flask, jsonify
from pymongo import MongoClient
import redis
import json

app = Flask(__name__)

# MongoDB connection
MONGO_URI = os.getenv("MONGO_URI", "mongodb://mongo:27017/assessment")
mongo_client = MongoClient(
    MONGO_URI,
    maxPoolSize=50,  # Increase connection pool
    minPoolSize=10,
    maxIdleTimeMS=30000,
    serverSelectionTimeoutMS=5000
)
db = mongo_client.assessment
collection = db.data

# Redis connection
# Note: Kubernetes auto-injects REDIS_PORT as 'tcp://IP:port' for services named 'redis'
# We use REDIS_SERVICE_PORT to avoid conflict, or fallback to default 6379
REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT_STR = os.getenv("REDIS_SERVICE_PORT", "6379")
# Handle case where it might be a URL like 'tcp://IP:port'
if REDIS_PORT_STR.startswith("tcp://"):
    REDIS_PORT = 6379  # Use default
else:
    REDIS_PORT = int(REDIS_PORT_STR)
redis_client = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    decode_responses=True,
    socket_connect_timeout=2,
    socket_timeout=2,
    max_connections=100
)

# Cache TTL (Time To Live)
CACHE_TTL = 60  # 60 seconds

@app.route("/healthz")
def health():
    return jsonify({"status": "ok", "timestamp": datetime.utcnow().isoformat()})

@app.route("/readyz")
def ready():
    try:
        # Check MongoDB
        mongo_client.server_info()
        # Check Redis
        redis_client.ping()
        return jsonify({"status": "ready", "timestamp": datetime.utcnow().isoformat()})
    except Exception as e:
        return jsonify({"status": "not ready", "error": str(e)}), 503

@app.route("/api/stats")
def stats():
    try:
        count = collection.count_documents({})
        return jsonify({"count": count, "timestamp": datetime.utcnow().isoformat()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/data")
def api_data():
    """
    Main endpoint: 5 reads + 5 writes (CANNOT change loop bounds)
    Optimization: Cache reads, async writes
    """
    try:
        reads = []
        writes = []
        timestamp = datetime.utcnow().isoformat()

        # ========================================
        # READS (5 total - CACHED)
        # ========================================
        for i in range(5):  # CANNOT CHANGE THIS
            cache_key = f"read:{i}"
            
            # Try cache first
            cached = redis_client.get(cache_key)
            if cached:
                reads.append(json.loads(cached))
            else:
                # Cache miss - read from MongoDB
                doc = collection.find_one({"index": i})
                if doc:
                    doc['_id'] = str(doc['_id'])  # Convert ObjectId to string
                    reads.append(doc)
                    # Store in cache
                    redis_client.setex(cache_key, CACHE_TTL, json.dumps(doc))
                else:
                    # No document found - create one
                    new_doc = {
                        "index": i,
                        "value": f"read-{i}",
                        "timestamp": timestamp
                    }
                    collection.insert_one(new_doc)
                    new_doc['_id'] = str(new_doc['_id'])
                    reads.append(new_doc)
                    redis_client.setex(cache_key, CACHE_TTL, json.dumps(new_doc))

        # ========================================
        # WRITES (5 total - DIRECT for now)
        # ========================================
        for i in range(5):  # CANNOT CHANGE THIS
            doc = {
                "index": 1000 + i,
                "value": f"write-{i}",
                "timestamp": timestamp
            }
            result = collection.insert_one(doc)
            writes.append({"_id": str(result.inserted_id), **doc})

        return jsonify({
            "status": "success",
            "reads": reads,
            "writes": writes,
            "timestamp": timestamp,
            "cached_reads": sum(1 for r in reads if redis_client.exists(f"read:{reads.index(r)}"))
        })

    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
