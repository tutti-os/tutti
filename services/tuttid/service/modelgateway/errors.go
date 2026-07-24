package modelgateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type invalidRequestError struct {
	Param   string
	Code    string
	Message string
}

func (e *invalidRequestError) Error() string {
	return e.Message
}

type responsesErrorEnvelope struct {
	Error responsesError `json:"error"`
}

type responsesError struct {
	Message string  `json:"message"`
	Type    string  `json:"type"`
	Param   *string `json:"param"`
	Code    string  `json:"code"`
}

func writeResponsesError(
	writer http.ResponseWriter,
	status int,
	errorType string,
	code string,
	param string,
	message string,
) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	var encodedParam *string
	if strings.TrimSpace(param) != "" {
		value := param
		encodedParam = &value
	}
	_ = json.NewEncoder(writer).Encode(responsesErrorEnvelope{
		Error: responsesError{
			Message: message,
			Type:    errorType,
			Param:   encodedParam,
			Code:    code,
		},
	})
}

func sanitizedUpstreamBody(body []byte, secret string) []byte {
	if strings.TrimSpace(secret) == "" {
		return body
	}
	return []byte(strings.ReplaceAll(string(body), secret, "[REDACTED]"))
}

func invalidParam(param string, message string) error {
	return &invalidRequestError{Param: param, Code: "invalid_value", Message: message}
}

func withParam(err error, prefix string) error {
	var invalid *invalidRequestError
	if !errors.As(err, &invalid) {
		return err
	}
	copy := *invalid
	if copy.Param == "" {
		copy.Param = prefix
	} else {
		copy.Param = prefix + copy.Param
	}
	return &copy
}
