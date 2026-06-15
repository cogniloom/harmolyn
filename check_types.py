import json

path = "/home/hal9000/.gemini/antigravity-cli/brain/825c1ef9-3661-4981-a009-b6d4785a5944/.system_generated/logs/transcript_full.jsonl"
types = set()
with open(path, 'r') as f:
    for line in f:
        try:
            data = json.loads(line)
            types.add(data.get("type"))
        except:
            pass

print("Types found:", types)

