package contracts

import "unicode/utf8"

func JSWhitespace(value uint16) bool {
	return value >= 9 && value <= 13 || value == 32 || value == 0xa0 || value == 0x1680 || value >= 0x2000 && value <= 0x200a || value == 0x2028 || value == 0x2029 || value == 0x202f || value == 0x205f || value == 0x3000 || value == 0xfeff
}
func TrimJS(value string) string {
	units := UTF16(value)
	start, end := 0, len(units)
	for start < end && JSWhitespace(units[start]) {
		start++
	}
	for end > start && JSWhitespace(units[end-1]) {
		end--
	}
	return FromUTF16(units[start:end])
}
func CompactWhitespace(value string) string {
	output := []uint16{}
	whitespace := false
	for _, unit := range UTF16(value) {
		if JSWhitespace(unit) {
			whitespace = len(output) > 0
			continue
		}
		if whitespace {
			output = append(output, 32)
			whitespace = false
		}
		output = append(output, unit)
	}
	return FromUTF16(output)
}
func TextEncoder(value string) []byte {
	output := []byte{}
	for index := 0; index < len(value); {
		if _, ok := surrogate(value, index); ok {
			output = utf8.AppendRune(output, utf8.RuneError)
			index += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(value[index:])
		output = utf8.AppendRune(output, r)
		index += size
	}
	return output
}
