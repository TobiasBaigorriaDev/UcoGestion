import { z } from 'zod';

export const categoryIconNames = ['folder', 'apple', 'coffee', 'milk', 'wine', 'beef', 'fish', 'wheat', 'cake-slice', 'candy', 'shirt', 'pill', 'wrench', 'package', 'smartphone', 'leaf', 'shopping-basket', 'utensils', 'egg', 'flower-2', 'cup-soda', 'bottle-wine', 'beer', 'sandwich', 'pizza', 'popcorn', 'ice-cream-cone', 'cookie', 'croissant', 'banana', 'carrot', 'cherry', 'citrus', 'grape', 'salad', 'soup', 'drumstick', 'ham', 'cooking-pot', 'snowflake', 'spray-can', 'brush-cleaning', 'soap-dispenser-droplet', 'cigarette', 'newspaper', 'battery', 'ticket', 'shopping-bag', 'store', 'lollipop', 'nut', 'droplet'] as const;
export const categoryIconSchema = z.enum(categoryIconNames).nullable();
export type CategoryIconName = typeof categoryIconNames[number];
