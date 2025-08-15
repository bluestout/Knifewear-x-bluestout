import {
  reactExtension,
  InlineStack,
  Text,
  useCartLineTarget,
  useInstructions,
  useSettings,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension("purchase.checkout.cart-line-item.render-after", () => (
  <Extension />
));

function Extension() {
  const instructions = useInstructions();
  const cartLineTarget = useCartLineTarget();
  const settings = useSettings();
  const bladeGuardText = settings.blade_guard_text;
  if (!instructions.attributes.canUpdateAttributes) {
    return null;
  }
  const lineItem = cartLineTarget;
  const hasBladeGuard = lineItem?.attributes?.some(
    attribute => attribute.key === '_blade_guard' && attribute.value === '10'
  );
  if (!hasBladeGuard) {
    return null;
  }
  return (
    <InlineStack spacing="tight" alignment="center">
      <Text size="small" appearance="subdued">
        ⓘ {bladeGuardText}
      </Text>
    </InlineStack>
  );
}