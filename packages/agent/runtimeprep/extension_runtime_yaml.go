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
	if !slices.Equal(keyPath, []string{"skills", "external_dirs"}) {
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
	skills := yamlMappingValue(root, "skills")
	if skills == nil {
		skills = &yaml.Node{Kind: yaml.MappingNode}
		yamlSetMappingValue(root, "skills", skills)
	}
	if skills.Kind != yaml.MappingNode {
		return "", errors.New("extension runtime YAML skills must be a mapping")
	}
	externalDirs := yamlMappingValue(skills, "external_dirs")
	if externalDirs == nil {
		externalDirs = &yaml.Node{Kind: yaml.SequenceNode}
		yamlSetMappingValue(skills, "external_dirs", externalDirs)
	}
	if externalDirs.Kind != yaml.SequenceNode {
		return "", errors.New("extension runtime YAML skills.external_dirs must be a list")
	}
	existing := yamlStringSequenceValues(externalDirs)
	for _, dir := range dirs {
		if slices.Contains(existing, dir) {
			continue
		}
		externalDirs.Content = append(externalDirs.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: dir})
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
