#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "mcp>=1.2.0",
#   "httpx>=0.27.0",
# ]
# ///
"""Famly MCP server.

A local Model Context Protocol (MCP) server that exposes tools for querying the
Famly childcare platform's public GraphQL API (https://docs.famly.co/) from
Claude Desktop.

Tools
-----
- list_children     : the roster — children, optionally filtered by site.
- get_attendance    : child check-in / attendance records for a given date.
- run_graphql       : run an arbitrary GraphQL query (escape hatch).
- introspect_schema : discover the real schema (root query fields or a type).

Authentication uses a Famly API access token supplied via the
FAMLY_ACCESS_TOKEN environment variable (set it in the server's `env` block in
claude_desktop_config.json). See README.md for how to create a token.

The token is only ever read from the environment and sent to Famly over HTTPS —
it is never logged or written to disk by this server.
"""

from __future__ import annotations

import json
import os
from datetime import date as _date
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

# --- Configuration ----------------------------------------------------------

# Famly's public GraphQL endpoint. Override with FAMLY_API_BASE_URL if you are
# on the DACH region (https://famlyapi.famly.de/v1/graphql).
DEFAULT_GRAPHQL_URL = "https://famlyapi.famly.co/v1/graphql"

# Famly authenticates API tokens with this HTTP header.
AUTH_HEADER = "X-Famly-Accesstoken"

REQUEST_TIMEOUT = 30.0

mcp = FastMCP("famly")


# --- GraphQL transport (endpoint + auth are confirmed against Famly's docs) --

def _endpoint() -> str:
    return os.environ.get("FAMLY_API_BASE_URL", DEFAULT_GRAPHQL_URL)


def _access_token() -> str:
    token = os.environ.get("FAMLY_ACCESS_TOKEN")
    if not token:
        raise RuntimeError(
            "FAMLY_ACCESS_TOKEN is not set. Add your Famly API token to the "
            "server's `env` block in claude_desktop_config.json."
        )
    return token


async def graphql(query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
    """Execute a GraphQL request against Famly and return the parsed `data`.

    Raises RuntimeError with a readable message on transport or GraphQL errors.
    """
    headers = {
        AUTH_HEADER: _access_token(),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    payload: dict[str, Any] = {"query": query}
    if variables:
        # Drop keys whose value is None so unused optional filters don't get
        # sent as explicit nulls.
        payload["variables"] = {k: v for k, v in variables.items() if v is not None}

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.post(_endpoint(), headers=headers, json=payload)

    if resp.status_code in (401, 403):
        raise RuntimeError(
            f"Famly rejected the access token (HTTP {resp.status_code}). "
            "Check that FAMLY_ACCESS_TOKEN is valid and has not expired."
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"Famly API HTTP {resp.status_code}: {resp.text[:1000]}")

    body = resp.json()
    if body.get("errors"):
        # Surface GraphQL errors verbatim — they name the exact field or
        # argument to fix, which is what you need when adapting the starter
        # queries below to your account's schema.
        raise RuntimeError("Famly returned GraphQL errors:\n" + _as_text(body["errors"]))
    return body.get("data", {})


def _as_text(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False, default=str)


# --- Starter GraphQL queries -------------------------------------------------
#
# Famly's schema is large and the fields/arguments your token can see depend on
# your account's permissions, so treat the two queries below as STARTING
# POINTS. If a call returns a GraphQL error such as `Cannot query field "x"`,
# run the `introspect_schema` tool (or open Famly's GraphiQL explorer at
# https://famlyapi.famly.co/v1/graphiql) to find the correct names, then edit
# the constant here. The transport, endpoint and auth above are fixed; only
# these query strings should ever need tweaking.

ROSTER_QUERY = """
query Roster($siteIds: [ID!], $limit: Int) {
  children(siteIds: $siteIds, first: $limit) {
    results {
      id
      name { fullName firstName lastName }
      birthDate
      groups { id title }
    }
  }
}
"""

ATTENDANCE_QUERY = """
query Attendance($date: Date!, $siteIds: [ID!], $groupIds: [ID!]) {
  checkins(date: $date, siteIds: $siteIds, groupIds: $groupIds) {
    results {
      id
      childId
      siteId
      groupId
      checkinTime
      pickupTime
      checkoutTime
    }
  }
}
"""


# --- Tools -------------------------------------------------------------------

@mcp.tool()
async def list_children(site_ids: list[str] | None = None, limit: int = 100) -> str:
    """Fetch the roster: the list of children in your Famly account.

    Optionally filter to one or more Famly site IDs via `site_ids`. `limit`
    caps how many records are requested (default 100). Returns the raw GraphQL
    `data` as JSON.

    If you get a GraphQL error about an unknown field or argument, call
    `introspect_schema` (no arguments) to discover the correct query, then
    adjust ROSTER_QUERY in this server's source.
    """
    return _as_text(await graphql(ROSTER_QUERY, {"siteIds": site_ids, "limit": limit}))


@mcp.tool()
async def get_attendance(
    date: str | None = None,
    site_ids: list[str] | None = None,
    group_ids: list[str] | None = None,
) -> str:
    """Fetch child attendance / check-in records (check-in, pick-up and
    check-out times) for a single day.

    `date` is an ISO date like "2026-06-17" and defaults to today. Optionally
    filter by `site_ids` and/or `group_ids`. Returns the raw GraphQL `data` as
    JSON.

    If you get a GraphQL error about an unknown field or argument, call
    `introspect_schema` to discover the correct query, then adjust
    ATTENDANCE_QUERY in this server's source.
    """
    variables = {
        "date": date or _date.today().isoformat(),
        "siteIds": site_ids,
        "groupIds": group_ids,
    }
    return _as_text(await graphql(ATTENDANCE_QUERY, variables))


@mcp.tool()
async def run_graphql(query: str, variables: dict[str, Any] | None = None) -> str:
    """Run an arbitrary GraphQL query against Famly and return the JSON response.

    Use this for anything the other tools don't cover, or to test a query you
    copied from Famly's GraphiQL explorer. `query` is the GraphQL document;
    `variables` is an optional object of variable values.
    """
    return _as_text(await graphql(query, variables))


@mcp.tool()
async def introspect_schema(type_name: str | None = None) -> str:
    """Discover Famly's real GraphQL schema using standard introspection.

    Call with no arguments to list every root query field and its arguments —
    the quickest way to find the exact query and argument names your token can
    use. Pass a `type_name` (e.g. "Child" or "Checkin") to list that type's
    fields. Use this whenever a query returns "Cannot query field ..." so the
    starter queries can be corrected.
    """
    if type_name:
        query = """
        query IntrospectType($name: String!) {
          __type(name: $name) {
            name kind description
            fields {
              name description
              args { name description type { ...TypeRef } }
              type { ...TypeRef }
            }
            inputFields { name description type { ...TypeRef } }
            enumValues { name description }
          }
        }
        fragment TypeRef on __Type {
          kind name
          ofType { kind name ofType { kind name ofType { kind name } } }
        }
        """
        return _as_text(await graphql(query, {"name": type_name}))

    query = """
    {
      __schema {
        queryType {
          name
          fields { name description args { name description } }
        }
      }
    }
    """
    return _as_text(await graphql(query))


if __name__ == "__main__":
    # Claude Desktop launches local servers and talks to them over stdio.
    mcp.run(transport="stdio")
