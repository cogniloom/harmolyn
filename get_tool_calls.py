import json

path = "/home/hal9000/.gemini/antigravity-cli/brain/65bae45c-6fd5-47dd-946f-00d6b8169385/.system_generated/logs/transcript_full.jsonl"
with open(path, 'r') as f:
    for line in f:
        try:
            data = json.loads(line)
            if "tool_calls" in data and data["tool_calls"]:
                for tc in data["tool_calls"]:
                    name = tc["function"]["name"]
                    print(f"Tool call: {name}")
                    if name == "send_message":
                        args = json.loads(tc["function"]["arguments"])
                        print(args.get("Message", "")[:200])
                    elif name in ["write_to_file", "replace_file_content", "multi_replace_file_content"]:
                        args = json.loads(tc["function"]["arguments"])
                        print(f"File: {args.get('TargetFile')}")
        except:
            pass
