cat > readme.md << 'EOF'
# SAP CAP Bookshop

A full-stack SAP BTP application built with SAP Cloud Application Programming Model (CAP) and SAP Fiori Elements.

## Features
- Fiori Elements List Report with criticality-based stock indicators
- Object Page with two sections (Book Details, Stock Information)
- Full CRUD with draft mode (@odata.draft.enabled)
- Author value help dropdown
- Server-side validation on create and update
- Bound custom action (Restock) with parameter dialog
- OData V4 service with SQLite (local) / SAP HANA (production)

## Tech Stack
- SAP CAP Node.js (@sap/cds 9.9.2)
- SAP Fiori Elements (sap.fe.templates)
- SAP UI5 1.149.1
- OData V4
- SQLite (dev) / SAP HANA (prod)

## Run Locally
\`\`\`bash
npm install
cds watch
\`\`\`
Open: http://localhost:4004/bookshopui/index.html

## Project Structure
- db/ — CDS data model (Books, Authors)
- srv/ — OData service + business logic
- app/bookshop-ui/ — Fiori Elements UI
EOF
