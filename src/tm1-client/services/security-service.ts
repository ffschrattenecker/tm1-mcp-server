// Security domain service. Owns the OData calls under /api/v1/Users(...) and
// /api/v1/Groups(...) — client (user) CRUD and group membership management.
// TM1 11.8 exposes users at `/Users` (not `/Clients`); MCP surface keeps the
// "Client" terminology because that is what TM1 admins use day to day.
//
// See docs/ARCHITECTURE.md for the layering.
import type { Client } from "../../types.js";
import type { TM1HttpClient } from "../http.js";

export class SecurityService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List TM1 users (clients) with their group memberships.
   * GET /api/v1/Users?$expand=Groups
   */
  async listClients(): Promise<Client[]> {
    const res = await this.http.request<{ value: Client[] }>(
      "GET",
      "/api/v1/Users?$select=Name,FriendlyName,Type,Enabled&$expand=Groups",
    );
    return res.value;
  }
}
