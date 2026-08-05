package agent

import (
	"reflect"

	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

func (p *ActivityProjection) SetAnalyticsReporter(reporter reporterservice.Reporter) {
	if p == nil {
		return
	}
	if analyticsReporterIsNil(reporter) {
		reporter = nil
	}
	p.analyticsReporterMu.Lock()
	defer p.analyticsReporterMu.Unlock()
	p.analyticsReporter = reporter
}

func (p *ActivityProjection) analyticsReporterSnapshot() reporterservice.Reporter {
	if p == nil {
		return nil
	}
	p.analyticsReporterMu.RLock()
	defer p.analyticsReporterMu.RUnlock()
	return p.analyticsReporter
}

func analyticsReporterIsNil(reporter reporterservice.Reporter) bool {
	if reporter == nil {
		return true
	}
	value := reflect.ValueOf(reporter)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}
