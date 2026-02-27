// Copy this file to app-config.js and fill values.
window.THE_ONE_CONFIG = {
    // Example: "https://xxxxxx.supabase.co"
    supabaseUrl: "YOUR_SUPABASE_URL",
    // Supabase anon/public API key
    supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
    // Optional: a UUID user id for syncing CRM statuses to user_property_crm
    userId: "YOUR_USER_UUID",
    // Optional: disable remote CRM sync if RLS/policies are not ready yet
    crmSync: true,
    // Optional: max items loaded in feed
    feedLimit: 80
};
