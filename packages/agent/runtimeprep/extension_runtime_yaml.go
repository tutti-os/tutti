package runtimeprep

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

func mergeYAMLStringList(config string, keyPath []string, values []string) (string, error) {
	dirs := dedupeStringList(values)
	if len(dirs) == 0 {
		return config, nil
	}
	if !slices.Equal(keyPath, []string{"skills", "external_dirs"}) &&
		!slices.Equal(keyPath, []string{"plugins", "enabled"}) {
		return "", errors.New("extension runtime YAML list key is unsupported")
	}

	var doc yaml.Node
	if strings.TrimSpace(config) == "" {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	} else if err := yaml.Unmarshal([]byte(config), &doc); err != nil {
		return "", fmt.Errorf("parse extension runtime YAML config: %w", err)
	}
	root := yamlDocumentRoot(&doc)
	if root.Kind != yaml.MappingNode {
		return "", errors.New("extension runtime YAML config must be a mapping")
	}
	sectionName := keyPath[0]
	listName := keyPath[1]
	section := yamlMappingValue(root, sectionName)
	if section == nil {
		section = &yaml.Node{Kind: yaml.MappingNode}
		yamlSetMappingValue(root, sectionName, section)
	}
	if section.Kind != yaml.MappingNode {
		return "", fmt.Errorf("extension runtime YAML %s must be a mapping", sectionName)
	}
	list := yamlMappingValue(section, listName)
	if list == nil {
		list = &yaml.Node{Kind: yaml.SequenceNode}
		yamlSetMappingValue(section, listName, list)
	}
	if list.Kind != yaml.SequenceNode {
		return "", fmt.Errorf("extension runtime YAML %s.%s must be a list", sectionName, listName)
	}
	existing := yamlStringSequenceValues(list)
	for _, dir := range dirs {
		if slices.Contains(existing, dir) {
			continue
		}
		list.Content = append(list.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: dir})
		existing = append(existing, dir)
	}
	out, err := yaml.Marshal(&doc)
	if err != nil {
		return "", fmt.Errorf("write extension runtime YAML config: %w", err)
	}
	return string(out), nil
}

func dedupeStringList(paths []string) []string {
	result := make([]string, 0, len(paths))
	for _, path := range paths {
		result = appendUniquePath(result, path)
	}
	return result
}

func yamlDocumentRoot(doc *yaml.Node) *yaml.Node {
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		return doc.Content[0]
	}
	return doc
}

func yamlMappingValue(mapping *yaml.Node, key string) *yaml.Node {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key {
			return mapping.Content[index+1]
		}
	}
	return nil
}

func yamlSetMappingValue(mapping *yaml.Node, key string, value *yaml.Node) {
	mapping.Content = append(mapping.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		value,
	)
}

func yamlStringSequenceValues(sequence *yaml.Node) []string {
	result := []string{}
	for _, item := range sequence.Content {
		if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
			continue
		}
		result = appendUniquePath(result, item.Value)
	}
	return result
}
