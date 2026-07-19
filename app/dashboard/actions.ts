"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function createProduct(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
  });
  if (!store) {
    redirect("/dashboard");
  }

  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const priceInput = formData.get("price") as string;
  const priceInCents = Math.round(parseFloat(priceInput) * 100);

  if (!name) {
    throw new Error("Product name is required");
  }
  if (!Number.isFinite(priceInCents) || priceInCents < 0) {
    throw new Error("Enter a valid price");
  }

  const productCount = await prisma.product.count({
    where: { storeId: store.id },
  });

  await prisma.product.create({
    data: {
      storeId: store.id,
      name,
      description: description || null,
      priceInCents,
      position: productCount,
    },
  });

  redirect("/dashboard");
}

export async function editStore(formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
  });
  if (!store) {
    redirect("/dashboard");
  }

  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();

  if (!name) {
    throw new Error("Store name is required");
  }

  await prisma.store.update({
    where: { id: store.id },
    data: { name, description: description || null },
  });

  redirect("/dashboard");
}

export async function toggleStorePublished() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
  });
  if (!store) {
    redirect("/dashboard");
  }

  await prisma.store.update({
    where: { id: store.id },
    data: { published: !store.published },
  });

  redirect("/dashboard");
}

export async function editProduct(productId: string, formData: FormData) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const product = await prisma.product.findFirst({
    where: { id: productId, store: { userId: session.user.id } },
  });
  if (!product) {
    throw new Error("Product not found");
  }

  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const priceInput = formData.get("price") as string;
  const priceInCents = Math.round(parseFloat(priceInput) * 100);

  if (!name) {
    throw new Error("Product name is required");
  }
  if (!Number.isFinite(priceInCents) || priceInCents < 0) {
    throw new Error("Enter a valid price");
  }

  await prisma.product.update({
    where: { id: productId },
    data: { name, description: description || null, priceInCents },
  });

  redirect("/dashboard");
}

export async function toggleProductActive(productId: string) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const product = await prisma.product.findFirst({
    where: { id: productId, store: { userId: session.user.id } },
  });
  if (!product) {
    throw new Error("Product not found");
  }

  await prisma.product.update({
    where: { id: productId },
    data: { active: !product.active },
  });

  redirect("/dashboard");
}

export async function deleteProduct(productId: string) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const product = await prisma.product.findFirst({
    where: { id: productId, store: { userId: session.user.id } },
  });
  if (!product) {
    throw new Error("Product not found");
  }

  await prisma.product.delete({ where: { id: productId } });

  redirect("/dashboard");
}
