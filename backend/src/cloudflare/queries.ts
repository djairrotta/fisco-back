const firewall = (op: "gt" | "geq") =>
  `query Firewall($zoneTag: string!, $desde: Time!, $ate: Time!, $limite: Int!) {
  viewer {
    zones(filter: {zoneTag: $zoneTag}) {
      firewallEventsAdaptive(
        filter: {datetime_${op}: $desde, datetime_leq: $ate}
        limit: $limite
        orderBy: [datetime_ASC]
      ) {
        datetime
        clientIP
        clientCountryName
        clientAsn
        clientRequestHTTPHost
        clientRequestPath
        clientRequestHTTPMethodName
        edgeResponseStatus
        userAgent
        action
        source
        description
      }
    }
  }
}`;

const http = (op: "gt" | "geq") =>
  `query Http($zoneTag: string!, $desde: Time!, $ate: Time!, $limite: Int!) {
  viewer {
    zones(filter: {zoneTag: $zoneTag}) {
      httpRequestsAdaptiveGroups(
        filter: {datetimeMinute_${op}: $desde, datetimeMinute_leq: $ate}
        limit: $limite
        orderBy: [datetimeMinute_ASC]
      ) {
        count
        dimensions {
          datetimeMinute
          clientIP
          clientCountryName
          clientRequestHTTPHost
          clientRequestPath
          clientRequestHTTPMethodName
          edgeResponseStatus
          userAgent
        }
      }
    }
  }
}`;

// Primeira página: estritamente após o cursor. Páginas seguintes: a partir do
// último timestamp (inclusivo) com dedupe, para não pular linhas do mesmo instante.
// Obs.: clientAsn não é permitido em httpRequestsAdaptiveGroups neste plano.
export const FIREWALL_QUERY = firewall("gt");
export const FIREWALL_QUERY_GEQ = firewall("geq");
export const HTTP_QUERY = http("gt");
export const HTTP_QUERY_GEQ = http("geq");
