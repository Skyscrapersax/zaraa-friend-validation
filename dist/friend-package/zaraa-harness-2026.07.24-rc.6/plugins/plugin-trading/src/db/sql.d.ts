/**
 * Type declaration for importing .sql files as strings.
 * tsup is configured with `loader: { '.sql': 'text' }`.
 */
declare module "*.sql" {
	const content: string;
	export default content;
}
