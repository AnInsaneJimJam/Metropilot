# Monad agent platform

Users configure bounded agents for observing Monad markets and proposing permitted actions. Protocol selection and permission to execute an action are separate concepts.

## Language

**Selected connectors**:
The current protocol scope is Aave, Uniswap, and Curve. Selection names the protocols we support incrementally; it does not promise every action offered by those protocols.

**Connector**:
A reviewed, versioned set of protocol capabilities with explicit supported markets and limits.
_Avoid_: unrestricted protocol access

**Native oracle observation**:
A protocol’s own price calculation read from finalized chain state, with its method and units identified. Uniswap’s geometric TWAP, Curve’s EMA, and Aave’s USD oracle have different semantics.
_Avoid_: spot price, universal TWAP

**Paper execution**:
An action against virtual inventory with simulated effects, informed by real market observations.
_Avoid_: on-chain trade, live transaction

**Reserve rate**:
Aave’s annualized supply or variable borrowing rate, distinct from a compounded yield or a promised return.
_Avoid_: APY, guaranteed yield
