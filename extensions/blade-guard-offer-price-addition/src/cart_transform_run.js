// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 */

/**
 * @param {CartTransformRunInput} input
 */
export function cartTransformRun(input) {
  const operations = [];

  for (const line of input.cart.lines) {
    const bladeGuardAttribute = line.attribute;

    if (bladeGuardAttribute && bladeGuardAttribute.value) {
      const bladeGuardAmount = parseFloat(bladeGuardAttribute.value);
      if (!isNaN(bladeGuardAmount) && bladeGuardAmount > 0) {
        const currentPrice = parseFloat(line.cost.amountPerQuantity.amount);
        const newPrice = currentPrice + bladeGuardAmount;
        
        operations.push({
          lineUpdate: {
            cartLineId: line.id,
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: newPrice.toString()
                }
              }
            }
          }
        });
      }
    }
  }

  return { operations };
};