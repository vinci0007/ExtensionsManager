package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type InvokeParams struct {
	Capability string `json:"capability"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)

	for scanner.Scan() {
		var request Request
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			writeJSON(writer, map[string]any{
				"jsonrpc": "2.0",
				"id":      nil,
				"error": map[string]any{
					"code":    -32700,
					"message": "Parse error",
				},
			})
			continue
		}

		switch request.Method {
		case "extension/activate":
			writeJSON(writer, map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result":  true,
			})
		case "extension/deactivate":
			writeJSON(writer, map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result":  true,
			})
			return
		case "extension/invoke":
			var params InvokeParams
			_ = json.Unmarshal(request.Params, &params)
			if params.Capability == "demo.hello" {
				writeJSON(writer, map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"result": map[string]any{
						"message": "hello from go process extension",
					},
				})
			} else {
				writeJSON(writer, map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"error": map[string]any{
						"code":    -32601,
						"message": fmt.Sprintf("Unknown capability: %s", params.Capability),
					},
				})
			}
		default:
			writeJSON(writer, map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"error": map[string]any{
					"code":    -32601,
					"message": fmt.Sprintf("Unknown method: %s", request.Method),
				},
			})
		}
	}
}

func writeJSON(writer *bufio.Writer, payload any) {
	encoded, _ := json.Marshal(payload)
	_, _ = writer.WriteString(string(encoded) + "\n")
	_ = writer.Flush()
}
