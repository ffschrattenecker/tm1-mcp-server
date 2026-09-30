// Monitoring domain service. Owns runtime introspection — threads and
// sessions. Read endpoints plus the single mutating action `cancelThread`,
// which interrupts a running operation server-side.
//
// See docs/ARCHITECTURE.md for the layering.
import type { TM1HttpClient } from "../http.js";

export class MonitoringService {
  constructor(private readonly http: TM1HttpClient) {}
}
