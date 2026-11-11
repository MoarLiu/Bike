package services

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

var localMigrationChecksum = regexp.MustCompile(`^[a-f0-9]{64}$`)

func invalidLocalMigration() error {
	return fmt.Errorf("完整本机副本格式或校验无效，原数据已保留")
}

func migrationIdentity(value any) bool {
	text, ok := value.(string)
	return ok && text != "" && contracts.UTF16Length(text) <= 300
}

func migrationInteger(value any) bool {
	number, ok := value.(float64)
	return ok && number >= 0 && number <= 9007199254740991 && number == math.Trunc(number)
}

func migrationDate(value any) bool {
	text, ok := value.(string)
	if !ok {
		return false
	}
	layouts := []string{
		time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04",
		"2006-01-02", "2006-01", "2006", time.RFC1123, time.RFC1123Z,
		time.RFC822, time.RFC822Z, time.RFC850, time.ANSIC, time.UnixDate,
	}
	for _, layout := range layouts {
		if _, err := time.Parse(layout, text); err == nil {
			return true
		}
	}
	return false
}

func migrationObjectWithout(object *contracts.Object, excluded string) *contracts.Object {
	result := contracts.NewObject()
	for _, key := range object.Keys {
		if key != excluded {
			result.Set(key, object.Get(key))
		}
	}
	return result
}

// This mirrors assertValueBudget, including its conservative scalar and array
// accounting. JSON byte length alone does not bound arrays of tiny values.
func migrationValueBudget(value any) error {
	values, bytes := 0, 0
	var visit func(any, int) error
	visit = func(value any, depth int) error {
		values++
		if values > 2000000 || depth > contracts.Limits.JSONDepth {
			return fmt.Errorf("数据嵌套或字段数量超过处理预算，原数据已保留")
		}
		switch item := value.(type) {
		case *contracts.Object:
			bytes += len(item.Keys)*2 + 2
			for _, key := range item.Keys {
				bytes += len(key) + 2
			}
		case []any:
			bytes += len(item)*4 + 2
		case string:
			bytes += len(item) + 2
		default:
			bytes += 8
		}
		if bytes > contracts.Limits.DocumentBytes {
			return fmt.Errorf("数据超过 64 MiB 处理预算，原数据已保留")
		}
		switch item := value.(type) {
		case *contracts.Object:
			for _, key := range item.Keys {
				if err := visit(item.Get(key), depth+1); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range item {
				if err := visit(child, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return visit(value, 0)
}

func migrationTreeBudget(nodes []any, depth int, count *int) error {
	for _, value := range nodes {
		*count++
		if *count > contracts.Limits.DocumentNodes || depth > contracts.Limits.DesktopDepth {
			return fmt.Errorf("主题数量或深度超过处理预算，原数据已保留")
		}
		if node, ok := value.(*contracts.Object); ok {
			if err := migrationTreeBudget(node.Array("children"), depth+1, count); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrationWorkspaceBudget(value any) error {
	workspace, ok := value.(*contracts.Object)
	if !ok {
		return invalidLocalMigration()
	}
	for _, key := range []string{"documents", "trash"} {
		if workspace.Get(key) != nil {
			if _, ok := workspace.Get(key).([]any); !ok {
				return invalidLocalMigration()
			}
		}
	}
	documents := append([]any{}, workspace.Array("documents")...)
	for _, value := range workspace.Array("trash") {
		if entry, ok := value.(*contracts.Object); ok {
			documents = append(documents, entry.Get("document"))
		}
	}
	for _, value := range documents {
		if document, ok := value.(*contracts.Object); ok {
			count := 0
			if err := migrationTreeBudget(document.Array("nodes"), 1, &count); err != nil {
				return err
			}
		}
	}
	return migrationValueBudget(workspace)
}

func migrationAllowedFields(object *contracts.Object, allowed ...string) bool {
	for _, key := range object.Keys {
		found := false
		for _, name := range allowed {
			found = found || key == name
		}
		if !found {
			return false
		}
	}
	return true
}

func validateMigrationCopy(copy *contracts.Object, depth int) error {
	if copy == nil || copy.Get("format") != "bike-local-copy" || copy.Get("version") != float64(1) ||
		!migrationIdentity(copy.Get("id")) || !migrationDate(copy.Get("createdAt")) || depth > 16 {
		return invalidLocalMigration()
	}
	source, audit := copy.Child("source"), copy.Child("sourceAudit")
	if source == nil || !source.Has("actorId") || (source.Get("actorId") != nil && !migrationIdentity(source.Get("actorId"))) ||
		!migrationInteger(source.Get("revision")) || !localMigrationChecksum.MatchString(source.String("workspaceSha256")) ||
		audit == nil || audit.Child("receipts") == nil || !migrationAllowedFields(audit, "audit", "outbox", "receipts", "conflicts") {
		return invalidLocalMigration()
	}
	for _, key := range []string{"history", "recovery", "recoveryFiles", "archives", "assets"} {
		if _, ok := copy.Get(key).([]any); !ok {
			return invalidLocalMigration()
		}
	}
	for _, key := range []string{"audit", "outbox", "conflicts"} {
		if _, ok := audit.Get(key).([]any); !ok {
			return invalidLocalMigration()
		}
	}
	documentIDs := map[string]bool{}
	for _, value := range copy.Array("history") {
		row, ok := value.(*contracts.Object)
		if !ok || !migrationIdentity(row.Get("documentId")) || documentIDs[row.String("documentId")] {
			return invalidLocalMigration()
		}
		if _, ok := row.Get("snapshots").([]any); !ok {
			return invalidLocalMigration()
		}
		documentIDs[row.String("documentId")] = true
	}
	recoveryIDs := map[string]bool{}
	for _, value := range copy.Array("recovery") {
		snapshot, ok := value.(*contracts.Object)
		if !ok || !migrationIdentity(snapshot.Get("id")) || recoveryIDs[snapshot.String("id")] || !snapshot.Has("baseRevision") ||
			(snapshot.Get("baseRevision") != nil && !migrationInteger(snapshot.Get("baseRevision"))) {
			return invalidLocalMigration()
		}
		savedAt, ok := snapshot.Get("savedAt").(float64)
		if !ok || math.IsInf(savedAt, 0) || math.IsNaN(savedAt) {
			return invalidLocalMigration()
		}
		if err := migrationWorkspaceBudget(snapshot.Get("workspace")); err != nil {
			return err
		}
		recoveryIDs[snapshot.String("id")] = true
	}
	for _, value := range copy.Array("recoveryFiles") {
		file, ok := value.(*contracts.Object)
		if !ok || !migrationIdentity(file.Get("id")) {
			return invalidLocalMigration()
		}
		if _, ok := file.Get("content").(string); !ok {
			return invalidLocalMigration()
		}
	}
	for _, key := range []string{"preAttachment", "preOperation"} {
		if !copy.Has(key) {
			return invalidLocalMigration()
		}
		if copy.Get(key) != nil {
			if err := migrationWorkspaceBudget(copy.Get(key)); err != nil {
				return err
			}
		}
	}
	for _, value := range copy.Array("archives") {
		archive, _ := value.(*contracts.Object)
		if err := validateMigrationCopy(archive, depth+1); err != nil {
			return err
		}
	}
	if copy.Has("preferences") {
		preferences := copy.Child("preferences")
		if preferences == nil || !migrationAllowedFields(preferences, "theme", "bike.navigation.v1", "bike.mindmap.relations", "ai") {
			return invalidLocalMigration()
		}
		for _, key := range []string{"theme", "bike.navigation.v1", "bike.mindmap.relations"} {
			if preferences.Has(key) {
				if _, ok := preferences.Get(key).(string); !ok {
					return invalidLocalMigration()
				}
			}
		}
		if preferences.Has("ai") {
			ai := preferences.Child("ai")
			if ai == nil || !migrationAllowedFields(ai, "endpoint", "baseUrl", "model") {
				return invalidLocalMigration()
			}
		}
	}
	if copy.Has("credentials") {
		credentials := copy.Child("credentials")
		if credentials == nil || !migrationAllowedFields(credentials, "aiApiKey") {
			return invalidLocalMigration()
		}
		if _, ok := credentials.Get("aiApiKey").(string); !ok {
			return invalidLocalMigration()
		}
	}
	return nil
}

func migrationMetadata(value any) (Metadata, error) {
	object, ok := value.(*contracts.Object)
	if !ok {
		return Metadata{}, invalidLocalMigration()
	}
	length := object.Get("byteLength")
	if !migrationInteger(length) || length.(float64) > float64(contracts.Limits.AttachmentBytes) {
		return Metadata{}, invalidLocalMigration()
	}
	metadata := Metadata{MediaType: object.String("mediaType"), ByteLength: int64(length.(float64))}
	for _, key := range []string{"width", "height"} {
		if object.Has(key) {
			number := object.Get(key)
			if !migrationInteger(number) || number.(float64) < 1 || number.(float64) > 0xffffffff {
				return Metadata{}, invalidLocalMigration()
			}
			if key == "width" {
				metadata.Width = int(number.(float64))
			} else {
				metadata.Height = int(number.(float64))
			}
		}
	}
	return metadata, ValidateMetadata(metadata)
}

func migrationReferences(value any) (map[string]bool, map[string]Metadata, error) {
	if err := migrationValueBudget(value); err != nil {
		return nil, nil, err
	}
	ids, metadata := map[string]bool{}, map[string]Metadata{}
	addMetadata := func(id string, value any) error {
		if _, err := assetDigest(id); err != nil {
			return err
		}
		item, err := migrationMetadata(value)
		if err != nil {
			return err
		}
		if previous, exists := metadata[id]; exists && previous != item {
			return fmt.Errorf("完整本机副本的附件元数据冲突")
		}
		metadata[id] = item
		return nil
	}
	stack := []any{value}
	for len(stack) > 0 {
		item := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		switch item := item.(type) {
		case []any:
			stack = append(stack, item...)
		case *contracts.Object:
			if id, ok := item.Get("assetId").(string); ok && assetIDPattern.MatchString(id) {
				ids[id] = true
			}
			if id, ok := item.Get("assetId").(string); ok && item.Child("metadata") != nil {
				if err := addMetadata(id, item.Get("metadata")); err != nil {
					return nil, nil, err
				}
			}
			for _, key := range item.Keys {
				child := item.Get(key)
				if assetIDPattern.MatchString(key) {
					if object, ok := child.(*contracts.Object); ok && object.Has("byteLength") && object.Has("mediaType") {
						ids[key] = true
						if err := addMetadata(key, object); err != nil {
							return nil, nil, err
						}
					}
				}
				stack = append(stack, child)
			}
		}
	}
	return ids, metadata, nil
}

// validateLocalMigration is the Go archive counterpart of readLocalMigration.
// ParseJSON/Digest retain JS numbers, UTF-16 strings, missing optional fields and
// unknown properties while hashing. The original ordered object is returned for
// the bridge response so a complete copy survives a JS-Go-JS round trip.
func validateLocalMigration(raw []byte, live []Asset) (*contracts.Object, []Asset, error) {
	value, err := contracts.ParseJSON(raw)
	if err != nil {
		return nil, nil, err
	}
	workspace, ok := value.(*contracts.Object)
	if !ok {
		return nil, nil, invalidLocalMigration()
	}
	copy := workspace.Child("localMigration")
	if err := migrationWorkspaceBudget(workspace); err != nil {
		return nil, nil, err
	}
	if err := validateMigrationCopy(copy, 0); err != nil {
		return nil, nil, err
	}
	body := migrationObjectWithout(workspace, "localMigration")
	contents := migrationObjectWithout(copy, "assets")
	for _, key := range []string{"source", "preferences", "credentials"} {
		contents.Delete(key)
	}
	referenceValue := contracts.NewObject()
	referenceValue.Set("workspace", body)
	referenceValue.Set("contents", contents)
	ids, metadata, err := migrationReferences(referenceValue)
	if err != nil {
		return nil, nil, err
	}
	indexed := map[string]Metadata{}
	for _, value := range copy.Array("assets") {
		item, ok := value.(*contracts.Object)
		if !ok {
			return nil, nil, invalidLocalMigration()
		}
		id := item.String("assetId")
		if _, err := assetDigest(id); err != nil {
			return nil, nil, err
		}
		if _, exists := indexed[id]; exists {
			return nil, nil, invalidLocalMigration()
		}
		itemMetadata, err := migrationMetadata(item.Get("metadata"))
		if err != nil {
			return nil, nil, err
		}
		indexed[id] = itemMetadata
	}
	if len(indexed) != len(ids) {
		return nil, nil, fmt.Errorf("完整本机副本的历史或备用附件清单不闭合")
	}
	for id := range ids {
		if _, exists := indexed[id]; !exists {
			return nil, nil, fmt.Errorf("完整本机副本的历史或备用附件清单不闭合")
		}
	}
	for _, item := range live {
		if indexed[item.AssetID] != item.Metadata {
			return nil, nil, invalidLocalMigration()
		}
	}
	for id, item := range metadata {
		if indexed[id] != item {
			return nil, nil, invalidLocalMigration()
		}
	}
	sourceDigest, err := contracts.Digest(body)
	if err != nil {
		return nil, nil, err
	}
	checksumValue := contracts.NewObject()
	checksumValue.Set("workspace", body)
	checksumValue.Set("localMigration", migrationObjectWithout(copy, "contentSha256"))
	contentDigest, err := contracts.Digest(checksumValue)
	if err != nil {
		return nil, nil, err
	}
	if sourceDigest != copy.Child("source").String("workspaceSha256") || contentDigest != copy.String("contentSha256") {
		return nil, nil, invalidLocalMigration()
	}
	assets := make([]Asset, 0, len(indexed))
	for id, metadata := range indexed {
		assets = append(assets, Asset{AssetID: id, Metadata: metadata})
	}
	sort.Slice(assets, func(left, right int) bool { return assets[left].AssetID < assets[right].AssetID })
	return workspace, assets, nil
}
