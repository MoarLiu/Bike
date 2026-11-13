package mcp

import (
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"regexp"
	"strings"
	"time"
)

var legacyDateSuffix = regexp.MustCompile(`^[A-Za-z]{3} [A-Za-z]{3} [0-9]{2} [0-9]{4} [0-9:]+ GMT[+-][0-9]{4} \(.+\)$`)
var legacyDateZones = map[string]int{"GMT": 0, "UTC": 0, "EST": -5, "EDT": -4, "CST": -6, "CDT": -5, "MST": -7, "MDT": -6, "PST": -8, "PDT": -7}

// Keep legacy JSON backups readable. RFC3339 is the format Bike writes;
// existing exports can also contain Date.toString(), RFC mail dates or
// slash-separated calendar dates accepted by the original JS reader.
func parseDocumentDate(value string) (time.Time, bool) {
	return parseDocumentDateInLocation(value, time.Local)
}
func parseDocumentDateInLocation(value string, location *time.Location) (time.Time, bool) {
	value = contracts.TrimJS(value)
	// ECMAScript ISO date-only strings use UTC. Date/time strings without an
	// offset and legacy calendar forms use the caller's local timezone.
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02", "2006-01", "2006"} {
		if at, err := time.Parse(layout, value); err == nil {
			return at, true
		}
	}
	if legacyDateSuffix.MatchString(value) {
		value = value[:strings.LastIndex(value, " (")]
	}
	for _, field := range strings.Fields(value) {
		if offset, ok := legacyDateZones[field]; ok {
			location = time.FixedZone(field, offset*3600)
			break
		}
	}
	for _, layout := range []string{
		"2006-1-2", "2006/1/2", "1/2/2006", "2006-01-02 15:04:05",
		"2006-01-02T15:04:05", "2006/01/02 15:04:05", time.RFC1123, time.RFC1123Z,
		time.RFC822, time.RFC822Z, time.RFC850, time.ANSIC, time.UnixDate,
		"Mon Jan 02 2006 15:04:05 GMT-0700 (MST)", "Mon Jan 02 2006 15:04:05 GMT-0700",
		"January 2, 2006", "Jan 2, 2006", "January 2 2006", "Jan 2 2006",
	} {
		if at, err := time.ParseInLocation(layout, value, location); err == nil {
			return at, true
		}
	}
	return time.Time{}, false
}
