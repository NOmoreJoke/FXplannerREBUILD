/*
  Warnings:

  - You are about to drop the `onboarding_drafts` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "onboarding_drafts" DROP CONSTRAINT "onboarding_drafts_user_id_fkey";

-- DropTable
DROP TABLE "onboarding_drafts";
