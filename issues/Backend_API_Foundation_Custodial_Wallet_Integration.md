## Title: Backend API Foundation & Custodial Wallet Integration

### Description:
Build the backend API for the Astra dashboard with full custodial wallet automation. Include endpoints for:
- Bot status
- Settings management
- Trade history
- Manual trade controls (signed with custodial wallet)
- Live logs (websocket)
- Wallet balance

Integrate custodial wallet using `wallet/custodial.js` for transaction signing. Support both paper trading and real on-chain mode. Call Jupiter API for swaps. Integrate with bot engine and strategies for full automation.