# API audit: Swagger Petstore - OpenAPI 3.0

Target: https://petstore3.swagger.io/api/v3  
Scanned: 2026-10-05T17:56:59.543Z  
Score: **4/100 (grade F)**

## Summary

Swagger Petstore - OpenAPI 3.0 scored 4/100 (grade F) across 8 endpoints, with 6 high and 0 medium issues.

## Findings

- **HIGH** `GET /pet/findByStatus`: Server error. Returned 500
- **HIGH** `GET /pet/findByTags`: Server error. Returned 500
- **HIGH** `GET /store/inventory`: Server error. Returned 500
- **HIGH** `GET /store/order/{orderId}`: Server error. Returned 500
- **HIGH** `GET /user/login`: Response is not valid JSON. The body could not be parsed
- **HIGH** `GET /user/{username}`: Server error. Returned 500
- **LOW** `API`: Missing X-Content-Type-Options. Add "nosniff" to stop MIME sniffing
- **LOW** `API`: Missing Strict-Transport-Security. HTTPS responses should send HSTS
- **LOW** `API`: CORS allows any origin. Access-Control-Allow-Origin is "*"

## Endpoints checked

| Endpoint | Status | Time | Issues |
|---|---|---|---|
| `GET /pet/findByStatus` | 500 | 114 ms | 1 |
| `GET /pet/findByTags` | 500 | 117 ms | 1 |
| `GET /pet/{petId}` | 200 | 116 ms | 0 |
| `GET /store/inventory` | 500 | 115 ms | 1 |
| `GET /store/order/{orderId}` | 500 | 117 ms | 1 |
| `GET /user/login` | 200 | 116 ms | 1 |
| `GET /user/logout` | 200 | 118 ms | 0 |
| `GET /user/{username}` | 500 | 116 ms | 1 |
