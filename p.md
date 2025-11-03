Premium: 1,343,250,000,000,000 wei
       = 0.00134325 tokens (assuming 18 decimals)
       = ~$0.00134 if it's a stablecoin
```

**This is just the insurance premium (the fee), NOT the coverage amount!**

---

### **What You're Insuring:**
```
Notional: 10,000,000,000,000,000,000 wei
        = 10 tokens (full tokens)
        = You're protecting 10 units of your assetToken
```

---

### **Your Coverage Terms:**

| Detail | Value | Meaning |
|--------|-------|---------|
| **Asset Token** | 0xc671...f0F1 | Token you're protecting |
| **Quote Token** | 0xC26e...E3B | What you measure price against |
| **Notional** | 10 tokens | Amount insured |
| **Duration** | 86,400 sec (1 day) | Coverage period |
| **Threshold** | 100 bps | **1% price drop** |
| **Purchase Ratio** | 4091382611951500970660 | Starting price |
| **Purchase Time** | Oct 16, 2025 4:08 PM | When bought |
| **Expiry Time** | Oct 17, 2025 4:08 PM | Coverage ends |

---

## 🎯 When Can You Claim?

### **Claim Conditions:**
✅ **Price must drop by MORE than 1%** from purchase ratio  
✅ **Must claim BEFORE Oct 17, 2025 4:08 PM** (expiry time)  
✅ **Policy must still be active** (not already claimed)

---

## 💰 Payout Calculation

Your threshold is **1%**, so you need the asset token to drop more than 1% against the quote token.

### **Example Scenarios:**

**Scenario 1: Price drops 1.5%**
```
Purchase Ratio: 4091382611951500970660
Current Ratio:  4030112233001979456600 (1.5% drop)

Drop = 1.5%
Threshold = 1%
Excess Drop = 1.5% - 1% = 0.5%

Payout = 10 tokens × 0.5% = 0.05 tokens
```

**Scenario 2: Price drops 5%**
```
Current Ratio: 3886813281453925921900 (5% drop)

Drop = 5%
Threshold = 1%
Excess Drop = 5% - 1% = 4%

Payout = 10 tokens × 4% = 0.4 tokens
```

**Scenario 3: Price drops 10%**
```
Current Ratio: 3682244350706355927594 (10% drop)

Drop = 10%
Threshold = 1%
Excess Drop = 10% - 1% = 9%

Payout = 10 tokens × 9% = 0.9 tokens
```

**Scenario 4: Price drops 0.8% (NOT ENOUGH)**
```
❌ Can't claim - need more than 1% drop