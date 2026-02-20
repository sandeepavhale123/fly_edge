import { serve } from "https://deno.land/std@0.131.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

console.log('Database connection test started');

serve(async (req: Request) => {
  try {
    // Get Supabase credentials from environment variables
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables'
        }),
        { headers: { "Content-Type": "application/json" }, status: 400 }
      );
    }

    // Initialize Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Query auth users (emails)
    const { data, error } = await supabase
      .from('auth.users')
      .select('id, email, created_at')
      .limit(100);

    if (error) {
      console.error('Database error:', error);
      return new Response(
        JSON.stringify({
          success: false,
          error: error.message,
          details: error
        }),
        { headers: { "Content-Type": "application/json" }, status: 500 }
      );
    }

    console.log('Successfully fetched auth emails:', data);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Database connection successful',
        auth_users_count: data?.length || 0,
        users: data || []
      }),
      { headers: { "Content-Type": "application/json", "Connection": "keep-alive" } }
    );

  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      { headers: { "Content-Type": "application/json" }, status: 500 }
    );
  }
}, { port: 9005 })
