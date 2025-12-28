-- Add seen_by column to track who has seen the message
ALTER TABLE public.messages ADD COLUMN seen_by jsonb DEFAULT '[]'::jsonb;

-- Create index for better performance
CREATE INDEX idx_messages_seen_by ON public.messages USING GIN(seen_by);