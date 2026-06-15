import json
import glob
import os

agent_dirs = glob.glob("/home/hal9000/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl")

for d in agent_dirs:
    with open(d, 'r') as f:
        lines = f.readlines()
        
    for line in reversed(lines):
        try:
            data = json.loads(line)
            if "tool_calls" in data and data["tool_calls"]:
                for tc in data["tool_calls"]:
                    if tc["function"]["name"] == "send_message":
                        args = json.loads(tc["function"]["arguments"])
                        print(f"--- From Agent in {d} ---")
                        print(args.get("Message", ""))
                        break
        except Exception as e:
            pass

