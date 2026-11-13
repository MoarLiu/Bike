package contracts

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Object retains JavaScript property insertion order and extension fields.
// Strings use WTF-8 internally only for isolated UTF-16 surrogate code units.
type Object struct {
	Keys   []string
	Values map[string]any
}

func (object *Object) MarshalJSON() ([]byte, error) { return Stringify(object, false, false) }

func NewObject() *Object { return &Object{Keys: []string{}, Values: map[string]any{}} }
func (object *Object) Get(key string) any {
	if object == nil {
		return nil
	}
	return object.Values[key]
}
func (object *Object) Has(key string) bool {
	if object == nil {
		return false
	}
	_, exists := object.Values[key]
	return exists
}
func (object *Object) Set(key string, value any) {
	if _, exists := object.Values[key]; !exists {
		object.Keys = append(object.Keys, key)
	}
	object.Values[key] = value
}
func (object *Object) Delete(key string) {
	if !object.Has(key) {
		return
	}
	delete(object.Values, key)
	for index, field := range object.Keys {
		if field == key {
			object.Keys = append(object.Keys[:index], object.Keys[index+1:]...)
			return
		}
	}
}
func (object *Object) String(key string) string { value, _ := object.Get(key).(string); return value }
func (object *Object) Array(key string) []any   { value, _ := object.Get(key).([]any); return value }
func (object *Object) Child(key string) *Object { value, _ := object.Get(key).(*Object); return value }

func ParseJSON(raw []byte) (any, error) {
	if len(raw) > Limits.DocumentBytes {
		return nil, fmt.Errorf("JSON 超过处理预算")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	count := 0
	value, err := readJSONValue(decoder, raw, 0, &count)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("JSON 包含额外内容")
	}
	return value, nil
}
func readJSONValue(decoder *json.Decoder, raw []byte, depth int, count *int) (any, error) {
	*count++
	if depth > Limits.JSONDepth || *count > 2000000 {
		return nil, fmt.Errorf("数据嵌套或字段数量超过处理预算")
	}
	before := int(decoder.InputOffset())
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value := token.(type) {
	case json.Delim:
		if value == '{' {
			object := NewObject()
			for decoder.More() {
				start := int(decoder.InputOffset())
				key, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				if _, ok := key.(string); !ok {
					return nil, fmt.Errorf("JSON 对象字段无效")
				}
				name := decodeString(raw[start:decoder.InputOffset()])
				item, err := readJSONValue(decoder, raw, depth+1, count)
				if err != nil {
					return nil, err
				}
				object.Set(name, item)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return object, nil
		}
		if value == '[' {
			array := []any{}
			for decoder.More() {
				item, err := readJSONValue(decoder, raw, depth+1, count)
				if err != nil {
					return nil, err
				}
				array = append(array, item)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return array, nil
		}
		return nil, fmt.Errorf("JSON 分隔符无效")
	case string:
		return decodeString(raw[before:decoder.InputOffset()]), nil
	case json.Number:
		number, err := strconv.ParseFloat(string(value), 64)
		if err != nil && !math.IsInf(number, 0) {
			return nil, err
		}
		return number, nil
	default:
		return value, nil
	}
}
func decodeString(raw []byte) string {
	raw = bytes.TrimLeft(raw, " ,:\t\r\n")
	if len(raw) < 2 {
		return ""
	}
	raw = raw[1 : len(raw)-1]
	output := []byte{}
	for index := 0; index < len(raw); {
		if raw[index] != '\\' {
			r, size := utf8.DecodeRune(raw[index:])
			output = utf8.AppendRune(output, r)
			index += size
			continue
		}
		index++
		if raw[index] != 'u' {
			switch raw[index] {
			case 'b':
				output = append(output, '\b')
			case 'f':
				output = append(output, '\f')
			case 'n':
				output = append(output, '\n')
			case 'r':
				output = append(output, '\r')
			case 't':
				output = append(output, '\t')
			default:
				output = append(output, raw[index])
			}
			index++
			continue
		}
		unit, _ := strconv.ParseUint(string(raw[index+1:index+5]), 16, 16)
		index += 5
		if unit >= 0xd800 && unit <= 0xdbff && index+6 <= len(raw) && raw[index] == '\\' && raw[index+1] == 'u' {
			low, _ := strconv.ParseUint(string(raw[index+2:index+6]), 16, 16)
			if low >= 0xdc00 && low <= 0xdfff {
				output = utf8.AppendRune(output, utf16.DecodeRune(rune(unit), rune(low)))
				index += 6
				continue
			}
		}
		if unit >= 0xd800 && unit <= 0xdfff {
			output = append(output, byte(0xe0|unit>>12), byte(0x80|(unit>>6)&63), byte(0x80|unit&63))
		} else {
			output = utf8.AppendRune(output, rune(unit))
		}
	}
	return string(output)
}
func surrogate(value string, index int) (uint16, bool) {
	if index+2 < len(value) && value[index] == 0xed && value[index+1] >= 0xa0 && value[index+1] <= 0xbf && value[index+2] >= 0x80 && value[index+2] <= 0xbf {
		return uint16(value[index]&15)<<12 | uint16(value[index+1]&63)<<6 | uint16(value[index+2]&63), true
	}
	return 0, false
}
func UTF16(value string) []uint16 {
	units := []uint16{}
	for index := 0; index < len(value); {
		if unit, ok := surrogate(value, index); ok {
			units = append(units, unit)
			index += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(value[index:])
		units = append(units, utf16.Encode([]rune{r})...)
		index += size
	}
	return units
}
func UTF16Length(value string) int { return len(UTF16(value)) }
func SliceUTF16(value string, start, end int) string {
	units := UTF16(value)
	start = max(0, min(start, len(units)))
	end = max(start, min(end, len(units)))
	units = units[start:end]
	return FromUTF16(units)
}
func FromUTF16(units []uint16) string {
	output := []byte{}
	for index := 0; index < len(units); index++ {
		unit := units[index]
		if unit >= 0xd800 && unit <= 0xdbff && index+1 < len(units) && units[index+1] >= 0xdc00 && units[index+1] <= 0xdfff {
			output = utf8.AppendRune(output, utf16.DecodeRune(rune(unit), rune(units[index+1])))
			index++
			continue
		}
		if unit >= 0xd800 && unit <= 0xdfff {
			output = append(output, byte(0xe0|unit>>12), byte(0x80|(unit>>6)&63), byte(0x80|unit&63))
		} else {
			output = utf8.AppendRune(output, rune(unit))
		}
	}
	return string(output)
}
func utf16Less(left, right string) bool {
	a, b := UTF16(left), UTF16(right)
	for index := 0; index < min(len(a), len(b)); index++ {
		if a[index] != b[index] {
			return a[index] < b[index]
		}
	}
	return len(a) < len(b)
}
func appendJSONString(output []byte, value string) []byte {
	output = append(output, '"')
	for index := 0; index < len(value); {
		if unit, ok := surrogate(value, index); ok {
			output = append(output, fmt.Sprintf("\\u%04x", unit)...)
			index += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(value[index:])
		index += size
		switch r {
		case '"', '\\':
			output = append(output, '\\', byte(r))
		case '\b':
			output = append(output, `\b`...)
		case '\f':
			output = append(output, `\f`...)
		case '\n':
			output = append(output, `\n`...)
		case '\r':
			output = append(output, `\r`...)
		case '\t':
			output = append(output, `\t`...)
		default:
			if r < 32 {
				output = append(output, fmt.Sprintf("\\u%04x", r)...)
			} else {
				output = utf8.AppendRune(output, r)
			}
		}
	}
	return append(output, '"')
}
func arrayIndex(key string) (uint64, bool) {
	number, err := strconv.ParseUint(key, 10, 32)
	return number, err == nil && number < 0xffffffff && strconv.FormatUint(number, 10) == key
}
func objectKeys(object *Object, canonical bool) []string {
	keys := append([]string{}, object.Keys...)
	if canonical {
		sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
	}
	sort.SliceStable(keys, func(i, j int) bool {
		a, ai := arrayIndex(keys[i])
		b, bi := arrayIndex(keys[j])
		if ai && bi {
			return a < b
		}
		return ai && !bi
	})
	return keys
}
func Stringify(value any, pretty, canonical bool) ([]byte, error) {
	return appendJSON(nil, value, pretty, canonical, 0)
}
func appendJSON(output []byte, value any, pretty, canonical bool, depth int) ([]byte, error) {
	if depth > Limits.JSONDepth {
		return nil, fmt.Errorf("JSON 嵌套超过预算")
	}
	newline := func(output []byte, level int) []byte {
		if pretty {
			output = append(output, '\n')
			output = append(output, strings.Repeat("  ", level)...)
		}
		return output
	}
	switch item := value.(type) {
	case *Object:
		if item == nil {
			return append(output, "null"...), nil
		}
		output = append(output, '{')
		keys := objectKeys(item, canonical)
		for index, key := range keys {
			if index > 0 {
				output = append(output, ',')
			}
			output = newline(output, depth+1)
			output = appendJSONString(output, key)
			output = append(output, ':')
			if pretty {
				output = append(output, ' ')
			}
			var err error
			output, err = appendJSON(output, item.Get(key), pretty, canonical, depth+1)
			if err != nil {
				return nil, err
			}
		}
		if len(keys) > 0 {
			output = newline(output, depth)
		}
		output = append(output, '}')
	case []any:
		output = append(output, '[')
		for index, child := range item {
			if index > 0 {
				output = append(output, ',')
			}
			output = newline(output, depth+1)
			var err error
			output, err = appendJSON(output, child, pretty, canonical, depth+1)
			if err != nil {
				return nil, err
			}
		}
		if len(item) > 0 {
			output = newline(output, depth)
		}
		output = append(output, ']')
	case []string:
		values := make([]any, len(item))
		for index, value := range item {
			values[index] = value
		}
		return appendJSON(output, values, pretty, canonical, depth)
	case map[string]any:
		keys := make([]string, 0, len(item))
		for key := range item {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		value := NewObject()
		for _, key := range keys {
			value.Set(key, item[key])
		}
		return appendJSON(output, value, pretty, canonical, depth)
	case string:
		output = appendJSONString(output, item)
	case float64:
		if math.IsNaN(item) || math.IsInf(item, 0) {
			output = append(output, "null"...)
		} else if item == 0 {
			output = append(output, '0')
		} else {
			encoded, _ := json.Marshal(item)
			output = append(output, encoded...)
		}
	case bool:
		output = strconv.AppendBool(output, item)
	case nil:
		output = append(output, "null"...)
	default:
		encoded, err := json.Marshal(item)
		if err != nil {
			return nil, err
		}
		parsed, err := ParseJSON(encoded)
		if err != nil {
			return nil, err
		}
		return appendJSON(output, parsed, pretty, canonical, depth)
	}
	if len(output) > Limits.DocumentBytes {
		return nil, fmt.Errorf("JSON 超过处理预算")
	}
	return output, nil
}
func Clone(value any) (any, error) {
	encoded, err := Stringify(value, false, false)
	if err != nil {
		return nil, err
	}
	return ParseJSON(encoded)
}
func Digest(value any) (string, error) {
	encoded, err := Stringify(value, false, true)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}
func ToPlain(value any) any {
	switch item := value.(type) {
	case *Object:
		result := map[string]any{}
		for _, key := range item.Keys {
			result[key] = ToPlain(item.Get(key))
		}
		return result
	case []any:
		result := make([]any, len(item))
		for index, value := range item {
			result[index] = ToPlain(value)
		}
		return result
	default:
		return value
	}
}
