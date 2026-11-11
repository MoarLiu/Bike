package contracts

import (
	"encoding/json"
	"os"
	"testing"
)

func TestJavaScriptJSONVectors(t *testing.T) {
	raw, err := os.ReadFile("../../tests/fixtures/canonical-json.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Raw       string `json:"raw"`
		Canonical string `json:"canonical"`
		Pretty    string `json:"pretty"`
		Digest    string `json:"digest"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for index, vector := range vectors {
		value, err := ParseJSON([]byte(vector.Raw))
		if err != nil {
			t.Fatalf("vector %d parse %v", index, err)
		}
		actual, err := Stringify(value, false, true)
		if err != nil || string(actual) != vector.Canonical {
			t.Fatalf("vector %d canonical %q expected %q error %v", index, actual, vector.Canonical, err)
		}
		pretty, err := Stringify(value, true, false)
		if err != nil || string(pretty) != vector.Pretty {
			t.Fatalf("vector %d pretty %q expected %q error %v", index, pretty, vector.Pretty, err)
		}
		digest, err := Digest(value)
		if err != nil || digest != vector.Digest {
			t.Fatalf("vector %d digest %s expected %s", index, digest, vector.Digest)
		}
	}
}
