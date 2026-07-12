# Smart Econometrics Recommendation
- Data structure: repeated_cross_section
- Recommended method: ols_regression
- Suggested covariance: robust
- Preferred entity variable: 省份
- Preferred time variable: year
- Preferred treatment variable: did
- Confidence: medium
## Reasons
- Detected repeated observations over time without a stable entity identifier, which fits repeated cross-section OLS as a baseline.
## Warnings
- None
## Post-estimation rules
- If heteroskedasticity tests fail, switch nonrobust inference to robust standard errors.
- If clustered SE are requested but the cluster count is too low, keep the warning and add a robust-SE comparison.
- If panel keys are incomplete or duplicate entity-time rows remain unresolved, downgrade FE to pooled OLS and report the downgrade clearly.
- If multicollinearity is severe, reduce overlapping controls before adding more robustness layers.
