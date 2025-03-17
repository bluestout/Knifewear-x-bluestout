const fetch = require('node-fetch');
require('dotenv').config();

module.exports = async (request, response) => {
    if (request.method !== 'POST') {
        return response.status(405).send({ error: 'Method not allowed' });
    }
    try {
        const webhookPayload = request.body;
        const orderId = webhookPayload.id;
        const shopifyEndpoint = `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-07/graphql.json`;
        const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

        // Process the order
        await processOrder(orderId, shopifyEndpoint, accessToken);

        // Send success response
        response.status(200).send({ success: true, message: 'Order processed successfully' });
    } catch (error) {
        console.error('Error processing order:', error);
        response.status(500).send({ error: error.message });
    }
};

/**
 * Main processing function for order
 */
async function processOrder(orderId, shopifyEndpoint, accessToken) {
    // Create API client
    const shopifyClient = createShopifyClient(shopifyEndpoint, accessToken);

    // Step 1: Fetch order data
    console.log(`Fetching data for order ${orderId}`);
    const orderData = await fetchOrderData(shopifyClient, orderId);

    // Step 2: Extract inventory items from order
    const inventoryItemIds = extractInventoryItemIds(orderData);

    // Step 3: Fetch inventory levels for all items
    const inventoryResults = await fetchInventoryLevels(shopifyClient, inventoryItemIds);

    // Step 4: Process location assignments based on warehouse availability
    await processLocationAssignments(shopifyClient, orderData, inventoryResults);

    console.log('Order location processing completed');
}

/**
 * Create a Shopify API client
 */
function createShopifyClient(endpoint, token) {
    return {
        call: async (query, variables) => {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': token,
                },
                body: JSON.stringify({ query, variables }),
            });

            const result = await res.json();
            if (result.errors) {
                throw new Error(result.errors[0].message);
            }
            return result.data;
        }
    };
}

/**
 * Fetch order data from Shopify
 */
async function fetchOrderData(client, orderId) {
    const orderQuery = `
        query($orderId: ID!) {
            order(id: $orderId) {
                id
                fulfillmentOrders(first: 10) {
                    edges {
                        node {
                            assignedLocation {
                                location {
                                    id
                                    name
                                }
                            }
                            id
                            status
                            requestStatus
                            lineItems(first: 10) {
                                edges {
                                    node {
                                        id
                                        remainingQuantity
                                        totalQuantity
                                        variant {
                                            inventoryItem {
                                                id
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    const orderVariables = {
        orderId: `gid://shopify/Order/${orderId}`,
    };

    return await client.call(orderQuery, orderVariables);
}

/**
 * Extract inventory item IDs from order data
 */
function extractInventoryItemIds(orderData) {
    const inventoryItemIds = [];

    if (!orderData.order || !orderData.order.fulfillmentOrders?.edges?.length) {
        return inventoryItemIds;
    }

    orderData.order.fulfillmentOrders.edges.forEach(fulfillmentOrderEdge => {
        const fulfillmentOrder = fulfillmentOrderEdge.node;

        fulfillmentOrder.lineItems?.edges?.forEach(lineItemEdge => {
            const lineItem = lineItemEdge.node;

            if (lineItem.variant?.inventoryItem?.id) {
                const inventoryItemId = lineItem.variant.inventoryItem.id;
                const idMatch = inventoryItemId.match(/gid:\/\/shopify\/InventoryItem\/(\d+)/);

                if (idMatch && idMatch[1]) {
                    inventoryItemIds.push(idMatch[1]);
                }
            }
        });
    });

    return inventoryItemIds;
}

/**
 * Fetch inventory levels for all items
 */
async function fetchInventoryLevels(client, inventoryItemIds) {
    const inventoryQuery = `
        query getInventoryLevels($inventoryItemId: ID!) {
            inventoryItem(id: $inventoryItemId) {
                id
                inventoryLevels(first: 50) {
                    edges {
                        node {
                            location {
                                id
                                name
                            }
                            quantities(names:["available"]) {
                                quantity
                            }
                        }
                    }
                }
            }
        }
    `;

    // Query inventory levels for each inventory item in parallel
    const inventoryResults = await Promise.all(inventoryItemIds.map(async (itemId) => {
        const inventoryVariables = {
            inventoryItemId: `gid://shopify/InventoryItem/${itemId}`
        };

        try {
            const inventoryData = await client.call(inventoryQuery, inventoryVariables);

            if (!inventoryData?.inventoryItem) {
                return null;
            }

            // Extract locations where the item has available inventory
            const inventoryLevels = inventoryData.inventoryItem.inventoryLevels.edges;
            const availableLocations = inventoryLevels
                .filter(edge => edge.node.quantities.some(q => q.quantity > 0))
                .map(edge => ({
                    locationId: edge.node.location.id,
                    locationName: edge.node.location.name,
                    quantity: edge.node.quantities.find(q => q.quantity > 0)?.quantity || 0
                }));

            // Log items available in Warehouse
            const warehouseLocation = availableLocations.find(loc => loc.locationName === 'Warehouse');
            if (warehouseLocation) {
                console.log(`Item ${itemId} is available in Warehouse with quantity: ${warehouseLocation.quantity}`);
            }

            return {
                inventoryItemId: itemId,
                availableLocations
            };
        } catch (error) {
            console.error(`Error fetching inventory for item ${itemId}:`, error);
            return null;
        }
    }));

    // Remove null values
    return inventoryResults.filter(result => result !== null);
}

/**
 * Process location assignments based on warehouse availability
 */
async function processLocationAssignments(client, orderData, inventoryResults) {
    if (!orderData.order || !orderData.order.fulfillmentOrders?.edges?.length) {
        console.log('No fulfillment orders found for this order');
        return;
    }

    const fulfillmentOrders = orderData.order.fulfillmentOrders.edges.map(edge => edge.node);

    // Find warehouse location ID from inventory results
    let warehouseLocationId = null;
    for (const inventoryResult of inventoryResults) {
        const warehouseLocation = inventoryResult.availableLocations.find(
            loc => loc.locationName === 'Warehouse'
        );
        if (warehouseLocation) {
            warehouseLocationId = warehouseLocation.locationId;
            break;
        }
    }

    if (!warehouseLocationId) {
        console.log('Warehouse location not found in inventory data');
        return;
    }

    // Process each fulfillment order
    for (const fulfillmentOrder of fulfillmentOrders) {
        // Skip if fulfillment order is not in an "open" state
        if (fulfillmentOrder.status !== 'OPEN') {
            console.log(`Skipping fulfillment order ${fulfillmentOrder.id} - not in OPEN state`);
            continue;
        }

        const currentLocationName = fulfillmentOrder.assignedLocation?.location?.name;

        // Already at warehouse, skip
        if (currentLocationName === 'Warehouse') {
            console.log('Order already assigned to Warehouse location');
            continue;
        }

        // Get line items and check availability for each
        const lineItems = fulfillmentOrder.lineItems.edges.map(edge => edge.node);
        const itemAvailability = await checkItemsAvailabilityInWarehouse(lineItems, inventoryResults);

        // Check if all items are available in warehouse
        const allItemsAvailable = itemAvailability.every(item => item.availableInWarehouse);

        if (allItemsAvailable) {
            console.log('All items available in warehouse - the order should be moved to warehouse');
        } else {
            // Some items available in warehouse, some not - using split fulfillment to handle them separately
            const availableItems = [];
            const unavailableItems = [];

            for (let i = 0; i < lineItems.length; i++) {
                if (itemAvailability[i].availableInWarehouse) {
                    availableItems.push({
                        fulfillmentOrderLineItemId: lineItems[i].id,
                        quantity: lineItems[i].remainingQuantity
                    });
                } else {
                    unavailableItems.push({
                        fulfillmentOrderLineItemId: lineItems[i].id,
                        quantity: lineItems[i].remainingQuantity
                    });
                }
            }

            console.log(`Found ${availableItems.length} items available in warehouse and ${unavailableItems.length} unavailable`);

            if (availableItems.length > 0 && unavailableItems.length > 0) {
                // We have both available and unavailable items - split the fulfillment order
                try {
                    console.log('Splitting fulfillment order');
                    const splitResult = await splitFulfillmentOrder(client, fulfillmentOrder.id, unavailableItems);

                    if (splitResult && splitResult.newFulfillmentOrders && splitResult.newFulfillmentOrders.length > 0) {
                        // Now move the new fulfillment order (with available items) to the warehouse
                        await moveFulfillmentOrder(client, splitResult.newFulfillmentOrders[0].id, warehouseLocationId);
                        console.log('Successfully processed split order');
                    }
                } catch (error) {
                    console.error('Error splitting fulfillment order:', error.message);
                }
            } else if (availableItems.length > 0) {
                console.log('All items available - order should be moved to warehouse');
            } else {
                console.log('No items available in warehouse - keeping order at current location');
            }
        }
    }
}

/**
 * Check availability of items in warehouse
 */
async function checkItemsAvailabilityInWarehouse(lineItems, inventoryResults) {
    return Promise.all(lineItems.map(async (lineItem) => {
        if (!lineItem.variant?.inventoryItem?.id) {
            return {
                lineItemId: lineItem.id,
                availableInWarehouse: false
            };
        }

        const inventoryItemId = lineItem.variant.inventoryItem.id;
        const idMatch = inventoryItemId.match(/gid:\/\/shopify\/InventoryItem\/(\d+)/);

        if (!idMatch || !idMatch[1]) {
            return {
                lineItemId: lineItem.id,
                availableInWarehouse: false
            };
        }

        const inventoryItemNumericId = idMatch[1];

        // Find inventory data for this item
        const inventoryData = inventoryResults.find(
            result => result.inventoryItemId === inventoryItemNumericId
        );

        if (!inventoryData) {
            return {
                lineItemId: lineItem.id,
                availableInWarehouse: false
            };
        }

        // Check if warehouse has enough quantity for this item
        const warehouseInventory = inventoryData.availableLocations.find(
            loc => loc.locationName === 'Warehouse'
        );

        const isAvailable = warehouseInventory &&
            warehouseInventory.quantity >= lineItem.remainingQuantity;

        return {
            lineItemId: lineItem.id,
            lineItemQuantity: lineItem.remainingQuantity,
            availableInWarehouse: isAvailable,
            warehouseQuantity: warehouseInventory?.quantity || 0
        };
    }));
}

/**
 * Move a fulfillment order to a different location
 */
async function moveFulfillmentOrder(client, fulfillmentOrderId, newLocationId) {
    const moveQuery = `
        mutation fulfillmentOrderMove($id: ID!, $newLocationId: ID!) {
            fulfillmentOrderMove(id: $id, newLocationId: $newLocationId) {
                movedFulfillmentOrder {
                    id
                    status
                }
                originalFulfillmentOrder {
                    id
                    status
                }
                remainingFulfillmentOrder {
                    id
                    status
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const moveVariables = {
        id: fulfillmentOrderId,
        newLocationId: newLocationId
    };

    const moveResult = await client.call(moveQuery, moveVariables);

    if (moveResult.fulfillmentOrderMove.userErrors.length > 0) {
        throw new Error(`Error moving fulfillment order: ${moveResult.fulfillmentOrderMove.userErrors[0].message}`);
    }
    return moveResult.fulfillmentOrderMove.fulfillmentOrder;
}

/**
 * Split a fulfillment order
 */
async function splitFulfillmentOrder(client, fulfillmentOrderId, lineItems) {
    const splitQuery = `
        mutation fulfillmentOrderSplit($fulfillmentOrderSplits: [FulfillmentOrderSplitInput!]!) {
            fulfillmentOrderSplit(fulfillmentOrderSplits: $fulfillmentOrderSplits) {
                fulfillmentOrderSplits {
                    fulfillmentOrder {
                        id
                        lineItems(first: 10) {
                            edges {
                                cursor
                                node {
                                    id
                                    totalQuantity
                                }
                            }
                        }
                    }
                    remainingFulfillmentOrder {
                        id
                        lineItems(first: 10) {
                            edges {
                                cursor
                                node {
                                    id
                                    totalQuantity
                                }
                            }
                        }
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    // Convert our line items to the format needed
    const formattedLineItems = lineItems.map(item => ({
        id: item.fulfillmentOrderLineItemId,
        quantity: item.quantity
    }));

    const splitVariables = {
        fulfillmentOrderSplits: [
            {
                fulfillmentOrderId: fulfillmentOrderId,
                fulfillmentOrderLineItems: formattedLineItems
            }
        ]
    };

    try {
        const splitResult = await client.call(splitQuery, splitVariables);
        // Check for errors
        if (splitResult.fulfillmentOrderSplit.userErrors &&
            splitResult.fulfillmentOrderSplit.userErrors.length > 0) {
            throw new Error(`Error splitting fulfillment order: ${splitResult.fulfillmentOrderSplit.userErrors[0].message}`);
        }
        // Return the newly created fulfillment orders
        return {
            newFulfillmentOrders: splitResult.fulfillmentOrderSplit.fulfillmentOrderSplits.map(
                split => split.fulfillmentOrder
            )
        };
    } catch (error) {
        console.error('Error splitting fulfillment order:', error);
        throw error;
    }
}
